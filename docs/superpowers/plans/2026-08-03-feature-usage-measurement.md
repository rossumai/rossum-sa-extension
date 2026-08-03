# Feature Usage Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship opt-in, anonymous per-feature usage counting to GA4 so unused features can be pruned and used ones prioritised, without adding a single required permission.

**Architecture:** Feature code calls `track(name)`, which posts a `chrome.runtime` message. The MV3 service worker is the only sender: it holds the consent gate, the client id and the single `fetch` to the GA4 Measurement Protocol. A pure module defines the closed event vocabulary and the parameter allowlist, so no free-form data can reach the payload.

**Tech Stack:** Vanilla ES modules + Preact (popup/Console/DevTools), esbuild, Vitest, GA4 Measurement Protocol.

**Spec:** `docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md` — read it before Task 1.

## Global Constraints

- **Never `git commit`.** The owner requires explicit approval for every commit, and the whole run lands as ONE commit. Each task ends with `git add` only. Never add a `Co-Authored-By: Claude` trailer.
- **No new required permissions.** Nothing may be added to `permissions`, `host_permissions` or `content_scripts.matches` in `manifest.json` — *"When a new permission that triggers a warning is added, the extension will be disabled until the user accepts the new permission."* 108 live installs would be disabled. The only permitted manifest change is the `optional_host_permissions` fallback in Task 1, and only if Task 1 proves it necessary.
- **`chrome.alarms` is forbidden** for the daily snapshot — it is a permission. The snapshot piggybacks on the first event of the day.
- **Nothing but allowlisted params may be sent.** No URL, host, org domain, name, email, token, or any queue/collection/annotation/document identifier or content. Ever.
- **Telemetry may never affect a feature.** `track()` is never awaited, never throws, and returns `undefined`.
- **Tests:** Vitest, files named `*.test.js` in `tests/`, Preact components constructed with `h(Component, null)` — raw JSX inside a `.test.js` breaks the oxc parser. Run a single file with `npx vitest run tests/<file>`.
- **JSX unicode:** `\uXXXX` escapes do NOT work in JSX raw text or attribute values. Use the literal character (`—`, `›`) or a JS expression `{'—'}`.
- **Rebuild after every change:** `npm run build`. Tests read `src/`, but the browser runs `dist/`. Tell the owner to reload the extension at `chrome://extensions` before manual verification.
- **Popup height cap is 600px** (Chrome's limit, already the subject of commit `0ce76d3`). The consent card must not push the popup past it.
- **GA4 limits** (verified): event name `/^[a-z][a-z0-9_]{0,39}$/`, ≤25 params per event, param values ≤100 chars, ≤25 events per request, body <130 kB. No cap on distinct event names for web streams.

---

### Task 1: Verification gate G1 — does the worker's fetch need a host permission?

Blocking spike. **No product code is written or staged in this task.** The outcome decides whether Task 4 requests an optional host permission. The official Chrome GA4 guide's manifest declares only `storage`, which implies no host permission is needed — this task replaces that inference with an observation.

**Files:**
- Temporarily modify: `src/background/index.js` (reverted at the end of the task — nothing staged)

- [ ] **Step 1: Build the current extension**

Run: `npm run build`
Expected: `dist/` exists and contains `background.js`.

- [ ] **Step 2: Add a throwaway probe to the service worker**

Append to `src/background/index.js`:

```js
// TEMPORARY G1 PROBE — delete before staging.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type !== 'g1-probe') return;
    fetch('https://www.google-analytics.com/mp/collect?measurement_id=G-PROBE&api_secret=probe', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'g1.probe', events: [{ name: 'g1_probe', params: {} }] }),
    })
      .then((r) => chrome.storage.local.set({ __g1: `ok status=${r.status}` }))
      .catch((e) => chrome.storage.local.set({ __g1: `blocked ${String(e)}` }));
  });
}
```

- [ ] **Step 3: Load the built extension in a real Chrome profile**

Use the verified dogfood recipe: `agent-browser open chrome://extensions --profile "Profile 1" --extension dist`, or have the owner load `dist/` unpacked at `chrome://extensions` with Developer mode on.

- [ ] **Step 4: Fire the probe and read the result**

In the extension's **service worker** DevTools console (`chrome://extensions` → the extension → "service worker"), run:

```js
chrome.runtime.sendMessage({ type: 'g1-probe' });
// wait a second, then:
chrome.storage.local.get('__g1').then(console.log);
```

Expected on success: `{ __g1: "ok status=204" }` (GA4 returns 2xx even for an invalid measurement id — this task tests *permission*, not payload validity).
If it reads `blocked …`, record the exact error text.

- [ ] **Step 5: Record the outcome and revert the probe**

```bash
chrome.storage.local.remove('__g1')   # in the same console
git checkout -- src/background/index.js
npm run build
```

Write the observed result into the spec's §10 gate 5 as a one-line "Verified <date>: …" note.

- [ ] **Step 6: Branch on the outcome**

- **`ok status=2xx`** → no manifest change. Proceed to Task 2 unchanged.
- **`blocked …`** → add to `manifest.json` (and only this):

```json
"optional_host_permissions": ["https://www.google-analytics.com/*"],
```

and note that Task 5 Step 7 must then request it from the consent button's click handler (`chrome.permissions.request` requires a user gesture, which a button click satisfies). Re-verify after the change that an existing install is **not** disabled on update.

- [ ] **Step 7: Stage**

```bash
# Only if the fallback was needed:
git add manifest.json
```

---

### Task 2: Pure event module — vocabulary, allowlist, payload builder

**Files:**
- Create: `src/usage/event.js`
- Create: `src/usage/ga4Config.js`
- Test: `tests/usage-event.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `EVENT_NAMES: string[]`, `TOGGLE_FEATURES: string[]`, `SNAPSHOT_KEYS: Record<string,string>`, `GA4_ENDPOINT: string`, `GA4_DEBUG_ENDPOINT: string`, `buildSnapshotParams(stored: object) => Record<string, 0|1>`, `buildPayload({ name, params?, clientId, sessionId, version }) => object` (throws `Error` on any violation). `ga4Config.js` produces `MEASUREMENT_ID: string`, `API_SECRET: string`.

- [ ] **Step 1: Write the failing test**

Create `tests/usage-event.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  EVENT_NAMES, SNAPSHOT_KEYS, buildPayload, buildSnapshotParams,
} from '../src/usage/event.js';

const base = { clientId: 'c1', sessionId: 's1', version: 'abc1234' };

describe('telemetry event vocabulary', () => {
  it('every name satisfies GA4 naming rules', () => {
    for (const n of EVENT_NAMES) expect(n).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });

  it('has no duplicate names', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });
});

describe('buildPayload', () => {
  it('builds the MP body with the mandatory params', () => {
    const body = buildPayload({ ...base, name: 'sa_popup_open' });
    expect(body.client_id).toBe('c1');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe('sa_popup_open');
    expect(body.events[0].params).toEqual({
      ext_ver: 'abc1234', session_id: 's1', engagement_time_msec: 1,
    });
  });

  it('rejects an event name outside the vocabulary', () => {
    expect(() => buildPayload({ ...base, name: 'sa_made_up' })).toThrow(/unknown event/);
  });

  it('rejects a param key that is not allowlisted — the leak guard', () => {
    expect(() => buildPayload({ ...base, name: 'sa_popup_open', params: { org: 'acme' } }))
      .toThrow(/not allowed/);
    expect(() => buildPayload({ ...base, name: 'sa_popup_open', params: { page_location: 'https://x' } }))
      .toThrow(/not allowed/);
  });

  it('rejects a feature value outside the toggle enum', () => {
    expect(() => buildPayload({ ...base, name: 'sa_popup_toggle_on', params: { feature: 'whatever' } }))
      .toThrow(/not allowed/);
    expect(buildPayload({ ...base, name: 'sa_popup_toggle_on', params: { feature: 'scrollLockEnabled' } })
      .events[0].params.feature).toBe('scrollLockEnabled');
  });

  it('rejects a missing client id and an over-long version', () => {
    expect(() => buildPayload({ ...base, clientId: '', name: 'sa_popup_open' })).toThrow(/clientId/);
    expect(() => buildPayload({ ...base, version: 'v'.repeat(101), name: 'sa_popup_open' }))
      .toThrow(/not allowed/);
  });

  it('maps stored toggles to 0/1 snapshot params', () => {
    const params = buildSnapshotParams({ schemaAnnotationsEnabled: true, experimentalUnlocked: 1 });
    expect(params.schema_ids).toBe(1);
    expect(params.experimental).toBe(1);
    expect(params.resource_ids).toBe(0);
    expect(Object.keys(params).sort()).toEqual(Object.keys(SNAPSHOT_KEYS).sort());
  });

  it('accepts the snapshot event with all eight booleans', () => {
    const body = buildPayload({
      ...base, name: 'sa_config_snapshot', params: buildSnapshotParams({}),
    });
    expect(Object.keys(body.events[0].params).length).toBe(11);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage-event.test.js`
Expected: FAIL — cannot resolve `../src/usage/event.js`.

- [ ] **Step 3: Write the implementation**

Create `src/usage/ga4Config.js`:

```js
// GA4 destination for usage counting. Both values are public by nature: they
// ship inside the bundle and are therefore extractable, which means events can
// be forged. Accepted risk — this data steers our own roadmap, it is not a
// billing or security input (see the spec, §10).
//
// RELEASE GATE: these placeholders must be replaced with the real property's
// values before the Release workflow runs (Task 8).
export const MEASUREMENT_ID = 'G-UNSET';
export const API_SECRET = 'UNSET';
```

Create `src/usage/event.js`:

```js
// Pure. No chrome APIs, no DOM, no network. This module is the single
// definition of what may leave the browser: a closed event vocabulary plus a
// parameter allowlist. A feature author cannot attach free-form data because
// there is no key here for it to travel in.
export const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
export const GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';

// Adding a feature event means adding its name HERE and to PRIVACY.md, which
// publishes this list so the privacy claim is auditable rather than trusted.
// GA4 imposes no cap on distinct event names for web data streams.
export const EVENT_NAMES = [
  // Rossum content script — once per page load (they run off a MutationObserver)
  'sa_rossum_schema_ids',
  'sa_rossum_resource_ids',
  'sa_rossum_expand_formulas',
  'sa_rossum_expand_reasoning',
  'sa_rossum_scroll_lock',
  // Rossum content script — real interactions
  'sa_rossum_tooltip_close',
  'sa_rossum_mdh_suggest_click',
  // Other sites — once per page load
  'sa_netsuite_field_names',
  'sa_coupa_field_names',
  // Popup
  'sa_popup_open',
  'sa_popup_toggle_on',
  'sa_popup_toggle_off',
  'sa_popup_experimental_unlock',
  'sa_popup_unlock_annotation',
  // Console shell
  'sa_console_open',
  'sa_console_app_mdh',
  'sa_console_app_audit',
  'sa_console_app_inspector',
  'sa_console_app_galaxy',
  'sa_console_app_fabry',
  // Console apps — the actions worth ranking
  'sa_mdh_query_run',
  'sa_mdh_export',
  'sa_mdh_import',
  'sa_mdh_stages_view',
  'sa_mdh_agent_query',
  'sa_mdh_index_create',
  'sa_audit_search',
  'sa_audit_fabry_ask',
  'sa_inspector_report',
  'sa_inspector_followup',
  'sa_inspector_revalidate',
  'sa_fabry_chat_send',
  'sa_fabry_deep_verify',
  'sa_fabry_architect_check',
  'sa_fabry_architect_implement',
  // DevTools panel
  'sa_devtools_panel_open',
  'sa_devtools_save',
  'sa_devtools_request_bar',
  'sa_devtools_copy_curl',
  'sa_devtools_preview',
  // Configuration
  'sa_config_snapshot',
];

// The only legal values of the `feature` param: the popup's nine toggle keys
// (seven storage-backed + two page-flag).
export const TOGGLE_FEATURES = [
  'schemaAnnotationsEnabled',
  'resourceIdsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'netsuiteFieldNamesEnabled',
  'coupaFieldNamesEnabled',
  'devFeaturesEnabled',
  'devDebugEnabled',
];

// snapshot param name -> chrome.storage.local key
export const SNAPSHOT_KEYS = {
  schema_ids: 'schemaAnnotationsEnabled',
  resource_ids: 'resourceIdsEnabled',
  expand_formulas: 'expandFormulasEnabled',
  expand_reasoning: 'expandReasoningFieldsEnabled',
  scroll_lock: 'scrollLockEnabled',
  netsuite_fields: 'netsuiteFieldNamesEnabled',
  coupa_fields: 'coupaFieldNamesEnabled',
  experimental: 'experimentalUnlocked',
};

const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const isStr100 = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100;

// Allowlist: key -> validator. An absent key is REJECTED.
const PARAM_SPEC = {
  ext_ver: isStr100,
  session_id: isStr100,
  engagement_time_msec: (v) => v === 1,
  feature: (v) => TOGGLE_FEATURES.includes(v),
};
for (const param of Object.keys(SNAPSHOT_KEYS)) {
  PARAM_SPEC[param] = (v) => v === 0 || v === 1;
}

export function buildSnapshotParams(stored) {
  const out = {};
  for (const [param, key] of Object.entries(SNAPSHOT_KEYS)) {
    out[param] = stored && stored[key] ? 1 : 0;
  }
  return out;
}

export function buildPayload({ name, params = {}, clientId, sessionId, version }) {
  if (!EVENT_NAMES.includes(name)) throw new Error(`unknown event name: ${name}`);
  if (!NAME_RE.test(name)) throw new Error(`invalid GA4 event name: ${name}`);
  if (!isStr100(clientId)) throw new Error('clientId required');

  const merged = { ...params, ext_ver: version, session_id: sessionId, engagement_time_msec: 1 };
  const keys = Object.keys(merged);
  if (keys.length > 25) throw new Error('too many params');
  for (const key of keys) {
    const check = PARAM_SPEC[key];
    if (!check) throw new Error(`param not allowed: ${key}`);
    if (!check(merged[key])) throw new Error(`param value not allowed: ${key}`);
  }

  const body = { client_id: clientId, events: [{ name, params: merged }] };
  if (JSON.stringify(body).length >= 130 * 1024) throw new Error('payload too large');
  return body;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/usage-event.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Stage**

```bash
git add src/usage/event.js src/usage/ga4Config.js tests/usage-event.test.js
```

---

### Task 3: Worker-side collector + consent ownership

**Files:**
- Create: `src/usage/collect.js`
- Modify: `src/background/index.js` (append a second `onMessage` listener; do not touch the existing one)
- Test: `tests/usage-collect.test.js`

**Interfaces:**
- Consumes: `buildPayload`, `buildSnapshotParams`, `EVENT_NAMES`, `SNAPSHOT_KEYS`, `GA4_ENDPOINT` from `src/usage/event.js`; `MEASUREMENT_ID`, `API_SECRET` from `src/usage/ga4Config.js`.
- Produces: `defaultDeps: object`, `collect(msg, deps?) => Promise<number>` (count of requests sent; `0` when consent absent), `setConsent(value: boolean, deps?) => Promise<boolean>`.

Storage contract (new keys only, never repurposing an existing one): `usageConsent` (`true`/`false`/absent), `usageClientId` (uuid), `usageSnapshotDay` (`YYYY-MM-DD`, UTC) in `chrome.storage.local`; `usageSessionId` in `chrome.storage.session`.

- [ ] **Step 1: Write the failing test**

Create `tests/usage-collect.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { collect, setConsent } from '../src/usage/collect.js';

function makeDeps(local = {}, session = {}) {
  const sent = [];
  const deps = {
    sent,
    local,
    session,
    getLocal: (keys) => {
      const out = {};
      for (const k of keys) if (k in local) out[k] = local[k];
      return Promise.resolve(out);
    },
    setLocal: (obj) => { Object.assign(local, obj); return Promise.resolve(); },
    removeLocal: (keys) => { for (const k of keys) delete local[k]; return Promise.resolve(); },
    getSession: (keys) => {
      const out = {};
      for (const k of keys) if (k in session) out[k] = session[k];
      return Promise.resolve(out);
    },
    setSession: (obj) => { Object.assign(session, obj); return Promise.resolve(); },
    uuid: () => 'uuid-1',
    today: () => '2026-08-03',
    version: () => 'abc1234',
    endpoint: () => 'https://ga/collect',
    fetch: (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({ status: 204 }); },
  };
  return deps;
}

describe('consent gate', () => {
  it('sends nothing when consent was never given', async () => {
    const d = makeDeps({});
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(0);
    expect(d.sent).toEqual([]);
    expect(d.local.usageClientId).toBeUndefined();
  });

  it('sends nothing when consent is false or a truthy non-true value', async () => {
    for (const value of [false, 'true', 1]) {
      const d = makeDeps({ usageConsent: value, usageClientId: 'c1' });
      expect(await collect({ name: 'sa_popup_open' }, d)).toBe(0);
      expect(d.sent).toEqual([]);
    }
  });

  it('drops an event name outside the vocabulary', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    expect(await collect({ name: 'sa_evil' }, d)).toBe(0);
    expect(d.sent).toEqual([]);
  });

  it('drops an event carrying a non-allowlisted param instead of throwing', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    await expect(collect({ name: 'sa_popup_open', params: { org: 'acme' } }, d)).resolves.toBe(0);
    expect(d.sent).toEqual([]);
  });
});

describe('sending', () => {
  beforeEach(() => {});

  it('sends the event and creates a session id', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(1);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].url).toBe('https://ga/collect');
    expect(d.sent[0].body.events[0].name).toBe('sa_popup_open');
    expect(d.session.usageSessionId).toBe('uuid-1');
  });

  it('emits the config snapshot once per UTC day, piggybacked on the first event', async () => {
    const d = makeDeps({
      usageConsent: true, usageClientId: 'c1', schemaAnnotationsEnabled: true,
    });
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(2);
    expect(d.sent.map((s) => s.body.events[0].name))
      .toEqual(['sa_config_snapshot', 'sa_popup_open']);
    expect(d.sent[0].body.events[0].params.schema_ids).toBe(1);
    expect(d.local.usageSnapshotDay).toBe('2026-08-03');

    d.sent.length = 0;
    expect(await collect({ name: 'sa_popup_open' }, d)).toBe(1);
    expect(d.sent.map((s) => s.body.events[0].name)).toEqual(['sa_popup_open']);
  });

  it('never rejects when the network fails', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    d.fetch = () => Promise.reject(new Error('offline'));
    await expect(collect({ name: 'sa_popup_open' }, d)).resolves.toBe(0);
  });
});

describe('setConsent', () => {
  it('granting creates a client id exactly once', async () => {
    const d = makeDeps({});
    await setConsent(true, d);
    expect(d.local.usageConsent).toBe(true);
    expect(d.local.usageClientId).toBe('uuid-1');

    d.uuid = () => 'uuid-2';
    await setConsent(true, d);
    expect(d.local.usageClientId).toBe('uuid-1');
  });

  it('revoking deletes the client id and the snapshot marker', async () => {
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1', usageSnapshotDay: '2026-08-03' });
    await setConsent(false, d);
    expect(d.local.usageConsent).toBe(false);
    expect(d.local.usageClientId).toBeUndefined();
    expect(d.local.usageSnapshotDay).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage-collect.test.js`
Expected: FAIL — cannot resolve `../src/usage/collect.js`.

- [ ] **Step 3: Write the implementation**

Create `src/usage/collect.js`:

```js
import {
  buildPayload, buildSnapshotParams, EVENT_NAMES, SNAPSHOT_KEYS, GA4_ENDPOINT,
} from './event.js';
import { MEASUREMENT_ID, API_SECRET } from './ga4Config.js';

// Real IO, overridable per-call for tests (repo pattern: devtools/actions.js,
// popup/ReviewingLockBanner.jsx).
export const defaultDeps = {
  getLocal: (keys) => chrome.storage.local.get(keys),
  setLocal: (obj) => chrome.storage.local.set(obj),
  removeLocal: (keys) => chrome.storage.local.remove(keys),
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
// holds staged auth entries, and this module has no business reading them.
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

// Consent is owned here so exactly one place creates and destroys the
// identifier. Revoking deletes it, so a later re-opt-in is unlinkable.
export async function setConsent(value, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  if (value !== true) {
    await d.setLocal({ usageConsent: false });
    await d.removeLocal(['usageClientId', 'usageSnapshotDay']);
    return false;
  }
  await d.setLocal({ usageConsent: true });
  const { usageClientId } = await d.getLocal(['usageClientId']);
  if (!usageClientId) await d.setLocal({ usageClientId: d.uuid() });
  return true;
}

// Returns how many requests were sent. Never rejects: a telemetry failure must
// not surface anywhere. `0` covers no-consent, unknown name, invalid params and
// network failure alike.
export async function collect(msg, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  try {
    const name = msg && msg.name;
    if (typeof name !== 'string' || !EVENT_NAMES.includes(name)) return 0;

    const stored = await d.getLocal(READ_KEYS);
    if (stored.usageConsent !== true || !stored.usageClientId) return 0;

    let sent = 0;
    const day = d.today();
    if (stored.usageSnapshotDay !== day) {
      await d.setLocal({ usageSnapshotDay: day });
      await post(d, 'sa_config_snapshot', buildSnapshotParams(stored), stored.usageClientId);
      sent += 1;
    }
    if (name !== 'sa_config_snapshot') {
      await post(d, name, msg.params || {}, stored.usageClientId);
      sent += 1;
    }
    return sent;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Wire the worker**

Append to `src/background/index.js` (a **separate** listener — the existing one returns early for other message types, and leaving it untouched keeps the Dataset Management path unchanged):

```js
// Usage counting (opt-in). The worker is the ONLY sender: it owns the consent
// gate, the client id and the single fetch. See
// docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    // Only this extension's own contexts may emit events.
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === 'sa-usage') collect(msg).catch(() => {});
    else if (msg?.type === 'sa-usage-consent') setConsent(msg.value === true).catch(() => {});
  });
}
```

and add the import at the top of the file:

```js
import { collect, setConsent } from '../usage/collect.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/usage-collect.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Verify the whole suite still passes and the build is clean**

Run: `npx vitest run && npm run build`
Expected: all tests pass; `dist/background.js` rebuilt.

- [ ] **Step 7: Stage**

```bash
git add src/usage/collect.js src/background/index.js tests/usage-collect.test.js
```

---

### Task 4: `track()` client + content-script instrumentation

**Files:**
- Create: `src/usage/track.js`
- Modify: `src/rossum/features/schema-ids.js:57` (after `node.appendChild(span)`)
- Modify: `src/rossum/features/resource-ids.js:127` (end of `displayResourceId`)
- Modify: `src/rossum/features/expand-formulas.js:11` (after `button.click()`)
- Modify: `src/rossum/features/expand-reasoning.js` (after its `button.click()`)
- Modify: `src/rossum/features/scroll-lock.js:25` (after `element.__saScrollLockAttached = true;`)
- Modify: `src/rossum/features/closable-tooltips.js:91` (inside the `btn` click handler)
- Modify: `src/rossum/features/dataset-mgmt-suggest.js:75` (inside the `openBtn` click handler)
- Modify: `src/netsuite/index.js`, `src/coupa/index.js` (after the first label is annotated)
- Test: `tests/usage-track.test.js`

**Interfaces:**
- Consumes: nothing (posts a message; the worker validates).
- Produces: `track(name: string, params?: object) => undefined`, `trackOnce(name: string, params?: object) => undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/usage-track.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';

function stubRuntime() {
  const sent = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); },
    },
  };
  return sent;
}

// track.js keeps a module-level "already sent" set, so each test needs a fresh
// module instance rather than a reset helper exported for tests only.
async function freshTrack() {
  vi.resetModules();
  return import('../src/usage/track.js');
}

describe('track', () => {
  let sent;
  beforeEach(() => { sent = stubRuntime(); });

  it('posts the message shape the worker expects', async () => {
    const { track } = await freshTrack();
    track('sa_popup_open');
    expect(sent).toEqual([{ type: 'sa-usage', name: 'sa_popup_open' }]);
  });

  it('includes params only when given', async () => {
    const { track } = await freshTrack();
    track('sa_popup_toggle_on', { feature: 'scrollLockEnabled' });
    expect(sent[0].params).toEqual({ feature: 'scrollLockEnabled' });
  });

  it('returns undefined and never throws when messaging is unavailable', async () => {
    const { track } = await freshTrack();
    globalThis.chrome = {};
    expect(track('sa_popup_open')).toBeUndefined();
  });

  it('swallows a rejected sendMessage promise', async () => {
    const { track } = await freshTrack();
    globalThis.chrome = { runtime: { sendMessage: () => Promise.reject(new Error('no receiver')) } };
    expect(() => track('sa_popup_open')).not.toThrow();
    await Promise.resolve();
  });
});

describe('trackOnce', () => {
  let sent;
  beforeEach(() => { sent = stubRuntime(); });

  it('sends the first call and swallows every repeat in this page lifetime', async () => {
    const { trackOnce } = await freshTrack();
    for (let i = 0; i < 300; i += 1) trackOnce('sa_rossum_schema_ids');
    expect(sent).toHaveLength(1);
  });

  it('tracks each name independently', async () => {
    const { trackOnce } = await freshTrack();
    trackOnce('sa_rossum_schema_ids');
    trackOnce('sa_rossum_resource_ids');
    trackOnce('sa_rossum_schema_ids');
    expect(sent.map((m) => m.name)).toEqual(['sa_rossum_schema_ids', 'sa_rossum_resource_ids']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage-track.test.js`
Expected: FAIL — cannot resolve `../src/usage/track.js`.

- [ ] **Step 3: Write the implementation**

Create `src/usage/track.js`:

```js
// The only telemetry API feature code sees. Fire-and-forget by construction:
// never awaited, never throws, always returns undefined — a telemetry fault
// must not alter, delay or break a feature. The worker validates and may drop.
const sentOnce = new Set();

export function track(name, params) {
  try {
    const msg = { type: 'sa-usage', name };
    if (params) msg.params = params;
    const p = chrome.runtime.sendMessage(msg);
    // No receiver (worker asleep mid-teardown, page closing) rejects; ignore.
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // chrome.runtime missing or the context is being torn down.
  }
  return undefined;
}

// For features driven by the MutationObserver: they act per DOM node, so this
// collapses a whole page's activity into one event. The set lives for the
// content script instance, i.e. one page load.
export function trackOnce(name, params) {
  if (sentOnce.has(name)) return undefined;
  sentOnce.add(name);
  return track(name, params);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/usage-track.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Instrument the Rossum features at their first real action**

Each call goes where the feature has demonstrably *done* something — not where it was merely enabled (enablement is already covered by the config snapshot).

`src/rossum/features/schema-ids.js` — add the import at the top and the call after `node.appendChild(span);` at the end of `handleNode`:

```js
import { trackOnce } from '../../usage/track.js';
// …
    node.appendChild(span);
    trackOnce('sa_rossum_schema_ids');
```

`src/rossum/features/resource-ids.js` — import as above, then at the end of `displayResourceId`, after `node.appendChild(span);`:

```js
  node.appendChild(span);
  trackOnce('sa_rossum_resource_ids');
```

`src/rossum/features/expand-formulas.js` — import as above, then inside the loop after `button.click();`:

```js
    button.click();
    trackOnce('sa_rossum_expand_formulas');
```

`src/rossum/features/expand-reasoning.js` — the same shape, using `trackOnce('sa_rossum_expand_reasoning');` after its `button.click();`.

`src/rossum/features/scroll-lock.js` — import as above, then after `element.__saScrollLockAttached = true;`:

```js
  element.__saScrollLockAttached = true;
  trackOnce('sa_rossum_scroll_lock');
```

`src/rossum/features/closable-tooltips.js` — this one is a real click, so use `track` (every dismissal counts, that is the signal). Import `{ track }` and add it as the first statement inside the `btn.addEventListener('click', …)` handler at line 91:

```js
  btn.addEventListener('click', (e) => {
    track('sa_rossum_tooltip_close');
```

`src/rossum/features/dataset-mgmt-suggest.js` — import `{ track }` and add it as the first statement inside the `openBtn.addEventListener('click', …)` handler at line 75:

```js
  openBtn.addEventListener('click', () => {
    track('sa_rossum_mdh_suggest_click');
```

- [ ] **Step 6: Instrument NetSuite and Coupa**

In `src/netsuite/index.js`, import `{ trackOnce } from '../usage/track.js'` and call `trackOnce('sa_netsuite_field_names');` immediately after the line that first attaches an internal-name label to the DOM (locate it with `rg -n "appendChild|insertAdjacent" src/netsuite/index.js` and pick the annotation append, not a container creation).

Do the same in `src/coupa/index.js` with `trackOnce('sa_coupa_field_names');`.

- [ ] **Step 7: Verify nothing regressed**

Run: `npx vitest run && npm run build`
Expected: the full suite passes (including the existing `tests/rossum-features.test.js` and `tests/coupa.test.js`) and the build succeeds.

If a content-script test fails because `chrome` is undefined in jsdom, that is `track()` doing its job only if it *swallowed* the error — confirm the failure is in the test's own assertions, and if a test asserts on `chrome`, add the minimal `globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve() } }` stub to that test's setup rather than weakening `track`.

- [ ] **Step 8: Stage**

```bash
git add src/usage/track.js tests/usage-track.test.js src/rossum/features src/netsuite/index.js src/coupa/index.js
```

---

### Task 5: Popup consent card, standing toggle, and popup events

**Files:**
- Create: `src/popup/components/UsageCard.jsx`
- Modify: `src/popup/components/App.jsx` (state, `setStorageToggle`, `setMessageToggle`, `onVersionClick`, render)
- Modify: `src/popup/components/ReviewingLockBanner.jsx` (unlock success path)
- Modify: `src/popup/popup.css` (card styles)
- Test: `tests/popup-usage-card.test.js`

**Interfaces:**
- Consumes: `track` from `src/usage/track.js`.
- Produces: `UsageCard` default export, props `{ consent: true|false|null, onAnswer: (value: boolean) => void }`. `consent === null` renders the first-run card; `true`/`false` renders the standing toggle.

Consent state must be read **separately** from `STORAGE_TOGGLES`: that loop coerces with `!!`, which would collapse "never answered" into "declined".

- [ ] **Step 1: Write the failing test**

Create `tests/popup-usage-card.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import UsageCard from '../src/popup/components/UsageCard.jsx';

let root;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root');
});

describe('UsageCard — first run', () => {
  it('renders the card with both choices when consent is unanswered', () => {
    render(h(UsageCard, { consent: null, onAnswer: () => {} }), root);
    expect(root.textContent).toContain('Help decide what gets built');
    expect(root.querySelector('[data-testid="usage-accept"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="usage-decline"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="usage-toggle"]')).toBeNull();
  });

  it('states what is sent and what is never sent', () => {
    render(h(UsageCard, { consent: null, onAnswer: () => {} }), root);
    const text = root.textContent;
    expect(text).toContain('extension version');
    expect(text).toContain('Never');
    expect(text).toMatch(/org domains/);
  });

  it('reports true on accept and false on decline', () => {
    const answers = [];
    render(h(UsageCard, { consent: null, onAnswer: (v) => answers.push(v) }), root);
    root.querySelector('[data-testid="usage-accept"]').click();
    render(h(UsageCard, { consent: null, onAnswer: (v) => answers.push(v) }), root);
    root.querySelector('[data-testid="usage-decline"]').click();
    expect(answers).toEqual([true, false]);
  });
});

describe('UsageCard — answered', () => {
  it('collapses to a toggle, shown to accepters and decliners alike', () => {
    for (const consent of [true, false]) {
      render(h(UsageCard, { consent, onAnswer: () => {} }), root);
      const toggle = root.querySelector('[data-testid="usage-toggle"] input');
      expect(toggle).not.toBeNull();
      expect(toggle.checked).toBe(consent);
      expect(root.textContent).not.toContain('Help decide what gets built');
    }
  });

  it('reports the flipped value from the toggle', () => {
    const answers = [];
    render(h(UsageCard, { consent: false, onAnswer: (v) => answers.push(v) }), root);
    root.querySelector('[data-testid="usage-toggle"] input').click();
    expect(answers).toEqual([true]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/popup-usage-card.test.js`
Expected: FAIL — cannot resolve `UsageCard.jsx`.

- [ ] **Step 3: Write the implementation**

Create `src/popup/components/UsageCard.jsx` (note: literal `—` and `›` characters, because `\uXXXX` escapes do not work in JSX text):

```jsx
import { h, Fragment } from 'preact';
import Toggle from './Toggle.jsx';

const PRIVACY_URL = 'https://github.com/rossumai/rossum-sa-extension/blob/master/PRIVACY.md';

// consent === null  -> never answered, show the first-run card
// consent === true|false -> answered, show the standing toggle (to accepters and
// decliners alike, so a "no" can be reconsidered without ever nagging).
export default function UsageCard({ consent, onAnswer }) {
  if (consent !== null) {
    return (
      <div class="usage-row" data-testid="usage-toggle">
        <Toggle
          id="usageConsent"
          label="Count feature usage"
          hint="anonymous · helps decide what gets built"
          checked={consent}
          onChange={(v) => onAnswer(v)}
        />
      </div>
    );
  }

  return (
    <section class="card usage-card">
      <h3 class="section-title">Help decide what gets built</h3>
      <p class="usage-lede">
        We don't know which of these features anyone actually uses — so we guess, and keep
        maintaining things nobody opens. Turn this on and the extension counts{' '}
        <strong>which features get used</strong>. That's the whole thing.
      </p>
      <dl class="usage-facts">
        <dt>Sent</dt>
        <dd>the feature's name (e.g. "schema ID overlays") and the extension version.</dd>
        <dt>Never</dt>
        <dd>
          URLs, org domains, names, emails, tokens, documents, field or dataset contents.
          Nothing that could identify you or your customer.
        </dd>
      </dl>
      <p class="usage-lede">Not tracking you: building what helps, dropping what doesn't.</p>
      <div class="usage-actions">
        <button class="btn-primary" data-testid="usage-accept" onClick={() => onAnswer(true)}>
          Count feature usage
        </button>
        <button class="btn-ghost" data-testid="usage-decline" onClick={() => onAnswer(false)}>
          No thanks
        </button>
      </div>
      <p class="usage-foot">
        Reversible any time.{' '}
        <a class="footer-link" href={PRIVACY_URL} target="_blank" rel="noreferrer">What's sent ›</a>
      </p>
    </section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/popup-usage-card.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into the popup**

In `src/popup/components/App.jsx`:

Add imports:

```js
import UsageCard from './UsageCard.jsx';
import { track } from '../../usage/track.js';
```

Add state beside the existing `useState` calls:

```js
  // Read on its own, NOT via STORAGE_TOGGLES: that loop coerces with !!, which
  // would turn "never answered" (undefined) into "declined" (false).
  const [consent, setConsent] = useState(null);
```

Add an effect beside the existing storage read, and count the popup open:

```js
  useEffect(() => {
    chrome.storage.local.get(['usageConsent']).then((vals) => {
      setConsent(vals.usageConsent === true ? true : vals.usageConsent === false ? false : null);
    });
    track('sa_popup_open');
  }, []);
```

Add the answer handler next to `setStorageToggle`:

```js
  const onUsageAnswer = (value) => {
    setConsent(value);
    // The worker owns the identifier: it creates one on grant and deletes it on
    // revoke, so exactly one place can mint or destroy it.
    chrome.runtime.sendMessage({ type: 'sa-usage-consent', value }).catch(() => {});
  };
```

Add `track` calls to the three existing handlers, each immediately before the awaited storage write so the ordering is obvious:

```js
  const setStorageToggle = async (key, value) => {
    track(value ? 'sa_popup_toggle_on' : 'sa_popup_toggle_off', { feature: key });
    setStorageValues((prev) => ({ ...prev, [key]: value }));
    // …unchanged…
```

```js
  const setMessageToggle = async (key) => {
    const ok = await runInTab(tab.id, togglePageFlag, [key]);
    if (ok === true) {
      track(messageValues[key] ? 'sa_popup_toggle_off' : 'sa_popup_toggle_on', { feature: key });
      // …unchanged…
```

In `onVersionClick`, after `await chrome.storage.local.set({ experimentalUnlocked: next });`:

```js
    if (next) track('sa_popup_experimental_unlock');
```

Render the card at the top of `#mainContent`, immediately before `<div class="content-row">`:

```jsx
          <UsageCard consent={consent} onAnswer={onUsageAnswer} />
```

In `src/popup/components/ReviewingLockBanner.jsx`, import `{ track } from '../../usage/track.js'` and call `track('sa_popup_unlock_annotation');` on the successful unlock path, immediately before the tab reload.

- [ ] **Step 6: Style the card**

Add to `src/popup/popup.css`, reusing the existing variable system (`--`-prefixed colors already defined there):

```css
.usage-card { border-left: 3px solid var(--accent, #4a6cf7); }
.usage-lede { margin: 6px 0; font-size: 11px; line-height: 1.45; }
.usage-facts { margin: 8px 0; font-size: 11px; line-height: 1.4; }
.usage-facts dt { font-weight: 600; margin-top: 4px; }
.usage-facts dd { margin: 0 0 2px 0; opacity: 0.85; }
.usage-actions { display: flex; gap: 8px; margin-top: 8px; }
.usage-foot { margin-top: 6px; font-size: 10px; opacity: 0.75; }
.usage-row { padding: 4px 0; }
```

If `.btn-primary` / `.btn-ghost` do not already exist in `popup.css`, add minimal rules for them next to the existing button classes — check first with `rg -n "btn-primary|btn-ghost" src/popup/popup.css`.

- [ ] **Step 7: Apply the Task 1 fallback, if and only if G1 failed**

Only if Task 1 recorded `blocked`: in `onUsageAnswer`, request the optional host permission **inside the click-driven path** (a user gesture is required) before messaging the worker:

```js
  const onUsageAnswer = async (value) => {
    if (value === true) {
      const ok = await chrome.permissions.request({ origins: ['https://www.google-analytics.com/*'] });
      if (!ok) return;   // treat a refused permission as "not answered": leave the card up
    }
    setConsent(value);
    chrome.runtime.sendMessage({ type: 'sa-usage-consent', value }).catch(() => {});
  };
```

- [ ] **Step 8: Verify in the real popup**

Run: `npx vitest run && npm run build`, then have the owner reload the extension and open the popup on a Rossum tab.
Expected: the card appears once, the popup does **not** exceed 600px (scroll bar absent or the card visibly fits), clicking either button collapses it to the toggle, and reopening the popup keeps that state.

- [ ] **Step 9: Stage**

```bash
git add src/popup src/usage tests/popup-usage-card.test.js
```

---

### Task 6: Console shell, Console apps and DevTools instrumentation

**Files:**
- Modify: `src/console/index.jsx` (after `activeApp.value = initial;` and beside the existing `writeTabState` effect)
- Modify: `src/mdh/hooks/useQuery.js` (`runQuery`), `src/mdh/components/ExportWizard.jsx` (`onExport` call), `src/mdh/components/ImportWizard.jsx` (`startImport`), `src/mdh/components/DataPanel.jsx:422`, `src/mdh/components/AgentBox.jsx:215`, `src/mdh/components/IndexPanel.jsx:86`
- Modify: `src/audit/index.jsx` (`runDefaultSummary`, `askAuditFabry`)
- Modify: `src/inspector/index.jsx` (`prefetchAndOrchestrate`, `askFabry`, `runRevalidate`)
- Modify: `src/fabry/chat.js` (`sendMessage`), `src/fabry/architect/actions.js` (`runAll`, `reRun`, `reImplement`)
- Modify: `src/devtools/panel.jsx` (mount, curl copy, request-bar submit, preview render), `src/devtools/actions.js` (`saveResource` success)
- Test: `tests/usage-console-events.test.js`

**Interfaces:**
- Consumes: `track` from `src/usage/track.js`; `EVENT_NAMES` from `src/usage/event.js`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

This task's risk is a typo'd event name silently dropping data, so the test asserts every name used in the tree is in the vocabulary. Create `tests/usage-console-events.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { EVENT_NAMES } from '../src/usage/event.js';

const ROOT = process.cwd();

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

// Every string literal passed to track()/trackOnce() anywhere in src/ must be a
// name the vocabulary knows, or the worker silently drops the event.
describe('instrumented event names', () => {
  const used = new Set();
  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\btrack(?:Once)?\(\s*'([^']+)'/g)) used.add(m[1]);
  }

  it('found call sites', () => {
    expect(used.size).toBeGreaterThan(20);
  });

  it('uses only names from the vocabulary', () => {
    expect([...used].filter((n) => !EVENT_NAMES.includes(n))).toEqual([]);
  });

  it('covers every Console app and the DevTools panel', () => {
    for (const n of [
      'sa_console_open', 'sa_console_app_mdh', 'sa_console_app_audit',
      'sa_console_app_inspector', 'sa_console_app_galaxy', 'sa_console_app_fabry',
      'sa_devtools_panel_open',
    ]) expect(used.has(n)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/usage-console-events.test.js`
Expected: FAIL — the Console/DevTools names are not used anywhere yet.

- [ ] **Step 3: Instrument the Console shell**

In `src/console/index.jsx`, add `import { track } from '../usage/track.js';` and, next to the existing `effect(() => { writeTabState('consoleActiveApp', activeApp.value); });`:

```js
const APP_EVENTS = {
  mdh: 'sa_console_app_mdh',
  audit: 'sa_console_app_audit',
  inspector: 'sa_console_app_inspector',
  galaxy: 'sa_console_app_galaxy',
  fabry: 'sa_console_app_fabry',
};
```

(top-level const, beside `TITLES`), and inside `boot()`:

```js
  track('sa_console_open');
  // Fires once on registration for the initially-active app, then on each switch.
  effect(() => {
    const name = APP_EVENTS[activeApp.value];
    if (name) track(name);
  });
```

Place the `effect` immediately after the existing `document.title` effect so both live together. Note this must be **after** `activeApp.value = initial;`, and it must also run on the early-return no-credentials path — put `track('sa_console_open')` directly after `activeApp.value = initial;`, and the `effect` in both branches (or move it above the `if (!token || !domain)` block, which is simpler and correct since it only reads a signal).

- [ ] **Step 4: Instrument the Console apps**

Add `import { track } from '../usage/track.js';` (adjust depth per file) and one call each, on the **success/entry** line named below:

| Event | File | Where exactly |
| --- | --- | --- |
| `sa_mdh_query_run` | `src/mdh/hooks/useQuery.js` | first statement inside `async function runQuery(collection, rawText, substituteFn)` |
| `sa_mdh_export` | `src/mdh/components/ExportWizard.jsx` | first statement of the handler that invokes the `onExport` prop |
| `sa_mdh_import` | `src/mdh/components/ImportWizard.jsx` | first statement of `startImport` |
| `sa_mdh_stages_view` | `src/mdh/components/DataPanel.jsx` | immediately before line 422's `resultsView.value = 'stages';` |
| `sa_mdh_agent_query` | `src/mdh/components/AgentBox.jsx` | immediately before line 215's `await runAgentQuery({` |
| `sa_mdh_index_create` | `src/mdh/components/IndexPanel.jsx` | immediately before line 86's `await api.createIndex(` |
| `sa_audit_search` | `src/audit/index.jsx` | first statement inside `runDefaultSummary()` after its two early-return guards |
| `sa_audit_fabry_ask` | `src/audit/index.jsx` | first statement inside `askAuditFabry(question)` |
| `sa_inspector_report` | `src/inspector/index.jsx` | first statement inside `prefetchAndOrchestrate()` |
| `sa_inspector_followup` | `src/inspector/index.jsx` | first statement inside `askFabry(question)` |
| `sa_inspector_revalidate` | `src/inspector/index.jsx` | first statement inside `runRevalidate()` |
| `sa_fabry_chat_send` | `src/fabry/chat.js` | first statement inside `sendMessage(text, images = [])` |
| `sa_fabry_deep_verify` | `src/fabry/chat.js` | inside `sendMessage`, guarded by the deep-mode branch that routes to `deepLoop` (locate with `rg -n "deepMode\|runDeepTurn" src/fabry/chat.js`) |
| `sa_fabry_architect_check` | `src/fabry/architect/actions.js` | first statement inside `runAll()` **and** inside `reRun(id)` |
| `sa_fabry_architect_implement` | `src/fabry/architect/actions.js` | first statement inside `reImplement(id)` |

Every call is `track('<name>');` with no params. Do **not** pass identifiers, collection names, questions or prompts — the payload allowlist would reject them, and the point is that they never travel.

- [ ] **Step 5: Instrument the DevTools panel**

In `src/devtools/panel.jsx`, add `import { track } from '../usage/track.js';` then:

- `track('sa_devtools_panel_open');` immediately after `if (mountEl) render(h(Panel, null), mountEl);` (line ~245).
- `track('sa_devtools_copy_curl');` as the first statement of the handler containing line 117's `buildCurl({ … })`.
- `track('sa_devtools_request_bar');` inside the `<RequestBar onSubmit={(raw) => {` callback at line ~176, as its first statement.
- `track('sa_devtools_preview');` immediately before the `<PreviewPane … />` render at line ~165 is not correct (renders repeat) — instead add it inside `src/devtools/PreviewPane.jsx` in a `useEffect(() => { track('sa_devtools_preview'); }, [])`, importing `useEffect` from `preact/hooks` if it is not already imported.

In `src/devtools/actions.js`, add the import and `track('sa_devtools_save');` on the **success** path of `saveResource` (after the PATCH resolves, before the page reload).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/usage-console-events.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Verify the whole suite and the build**

Run: `npx vitest run && npm run build`
Expected: every test passes. If a Console/Fabry/Inspector unit test now fails on a missing `chrome.runtime`, add the minimal stub to that test's setup: `globalThis.chrome = { ...globalThis.chrome, runtime: { sendMessage: () => Promise.resolve() } }`.

- [ ] **Step 8: Stage**

```bash
git add src/console src/mdh src/audit src/inspector src/fabry src/devtools tests/usage-console-events.test.js
```

---

### Task 7: Boundary test, privacy policy, and user-facing documentation

**Files:**
- Create: `tests/usage-boundary.test.js`
- Create: `PRIVACY.md`
- Modify: `README.md` (a short "Usage counting" section)
- Modify: `CLAUDE.md` (storage keys + a telemetry paragraph)
- Test: `tests/usage-boundary.test.js`

**Interfaces:**
- Consumes: `EVENT_NAMES` from `src/usage/event.js`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/usage-boundary.test.js`, modelled on the existing `tests/fabry-write-boundary.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { EVENT_NAMES } from '../src/usage/event.js';

// Network boundary: exactly ONE module may name the analytics host, and only the
// service worker may send. If the host appears anywhere else, some other surface
// grew its own sender — bypassing the consent gate and the payload allowlist.
const ROOT = process.cwd();
const HOST = 'google-analytics.com';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(ROOT.length + 1);

describe('telemetry network boundary', () => {
  it('only src/usage/event.js names the analytics host', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((p) => rel(p) !== 'src/usage/event.js')
      .filter((p) => readFileSync(p, 'utf8').includes(HOST))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('only the background bundle ships the host', () => {
    const dist = join(ROOT, 'dist');
    if (!existsSync(dist)) {
      throw new Error('run `npm run build` before this test — it inspects dist/');
    }
    const offenders = walk(dist)
      .filter((p) => rel(p) !== 'dist/background.js')
      .filter((p) => readFileSync(p, 'utf8').includes(HOST))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('PRIVACY.md', () => {
  const text = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');

  it('publishes every event name so the claim is auditable', () => {
    expect(EVENT_NAMES.filter((n) => !text.includes(n))).toEqual([]);
  });

  it('carries the Chrome Web Store Limited Use affirmation', () => {
    expect(text).toMatch(/Limited Use/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run tests/usage-boundary.test.js`
Expected: FAIL — `PRIVACY.md` does not exist. (The two boundary assertions should already pass; if the `dist/` one fails, a non-worker surface is importing `collect.js` — fix that, do not relax the test.)

- [ ] **Step 3: Write `PRIVACY.md`**

Create `PRIVACY.md` at the repo root:

```markdown
# Privacy policy — Rossum SA extension

Last updated: 2026-08-03

This is a community project, not an official Rossum product.

## What the extension stores on your device

Your feature toggles, per-tab navigation state (which Console app and collection
you had open), and the ids of annotations you recently opened in the Rossum UI.
All of it stays in your browser. None of it is transmitted anywhere.

While you use the Rossum Console or the DevTools panel, the extension calls the
Rossum API of the organisation you are signed in to, using your own session
token, to show you your own data. Nothing from those calls is sent to us.

## Usage counting — off unless you turn it on

The extension can count **which of its own features you use**, so that unused
features get removed instead of maintained and useful ones get improved. It is
off by default and does nothing until you enable it in the extension popup.
Turning it off again deletes the random identifier described below, so a later
re-enable cannot be linked to earlier counts.

When it is on, each counted action sends one request to Google Analytics 4
containing exactly:

- the event name — one of the names listed below, and nothing else;
- the extension version (a short git commit hash);
- a random identifier created when you enabled counting, stored on your device;
- a random per-browser-session identifier;
- for the once-a-day configuration event, one 0/1 flag per feature toggle.

The request is an ordinary HTTPS request, so Google receives your IP address at
the network layer as it would for any web request. Google's Measurement Protocol
does not include geolocation in the resulting data.

### Never sent

- any URL, hostname or organisation domain
- your name, e-mail address, username or API token
- any queue, workspace, hook, schema, rule, label, engine, collection, dataset,
  annotation or document identifier, name or content
- any query, aggregation pipeline, prompt or chat message

The payload is built from a fixed list of permitted fields; there is no field in
it that the data above could travel in.

### The complete list of event names

<!-- Keep in sync with EVENT_NAMES in src/usage/event.js — a test enforces
     that every name below exists there. -->

(list every name from `EVENT_NAMES`, one per line, each with a short plain-English
description — e.g. `sa_rossum_schema_ids` — the schema-ID overlay drew at least
one label on a page.)

## Data retention

Event data is retained in Google Analytics for at most 14 months.

## Your choices

Enable or disable counting any time in the extension popup. Disabling deletes the
identifier. Uninstalling the extension removes everything stored on your device.

## Limited Use

Our use of data received from this extension complies with the
[Chrome Web Store Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Contact

Open an issue at https://github.com/rossumai/rossum-sa-extension/issues
```

Replace the parenthesised instruction with the actual list — copy every entry of
`EVENT_NAMES` and write one short line per event. The test in Step 1 fails until
all of them are present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run tests/usage-boundary.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Document it for users and for future sessions**

Add to `README.md`, after the Features section:

```markdown
## Usage counting

The extension can count which of its own features you use, so unused features get
removed instead of maintained. It is **off by default**; enable it in the popup.
It never sends URLs, organisation domains, credentials, or any document, dataset
or field data — see [PRIVACY.md](PRIVACY.md) for the exact payload and the full
list of event names.
```

Add to `CLAUDE.md` under **Chrome Storage Keys**:

```markdown
- Usage counting (opt-in, off by default): `usageConsent` (`true`/`false`/absent —
  absent means never answered, which is why it is read separately from the
  popup's `!!`-coercing toggle loop), `usageClientId` (random uuid, created by the
  worker on consent and deleted on revoke), `usageSnapshotDay` (UTC `YYYY-MM-DD`
  marker for the once-a-day config snapshot); plus `usageSessionId` in
  `chrome.storage.session`. The service worker is the ONLY sender —
  `src/usage/track.js` messages it, `src/usage/collect.js` gates on
  consent and fetches GA4, `src/usage/event.js` (pure) defines the closed
  event vocabulary + param allowlist. `tests/usage-boundary.test.js` enforces
  that no other module names `google-analytics.com`. Spec:
  `docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md`.
```

- [ ] **Step 6: Stage**

```bash
git add tests/usage-boundary.test.js PRIVACY.md README.md CLAUDE.md
```

---

### Task 8: Release preparation — GA4 property, live smoke, store declarations

Owner-gated. Nothing here is a code change except Step 2.

**Files:**
- Modify: `src/usage/ga4Config.js`
- Modify: `docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md` (record verification outcomes)

**Already verified 2026-08-03 (does not need the property):** GA4's own
`/debug/mp/collect` validator returns `validationMessages: []` for both payload
shapes (a normal event and `sa_config_snapshot`), and the whole worker path was
exercised end-to-end in a freshly loaded `dist/`: no-consent send creates nothing
at all; grant mints a 36-char uuid; the first event sets `usageSnapshotDay` (so
the snapshot piggyback fires); revoke deletes the id AND the day marker and
counting stops; a re-grant mints a *different* id. Steps 3-5 below are therefore
already covered except for the Realtime confirmation, which needs the property.

- [ ] **Step 1: Owner creates the GA4 property**

A GA4 property with a **Web data stream**, then Admin → Data Streams → the
stream → **Measurement Protocol API secrets** → create one. Set Admin → Data
Settings → Data Retention → **14 months**. Confirm Google signals and ads
personalisation are off. Record who owns the property in the spec.

- [ ] **Step 2: Paste the real values**

Replace the placeholders in `src/usage/ga4Config.js` with the real
`MEASUREMENT_ID` (`G-…`) and `API_SECRET`, then `npm run build`.

- [ ] **Step 3: Smoke-test against the debug endpoint first**

Temporarily change `GA4_ENDPOINT` in `src/usage/ga4Config.js` to
`https://www.google-analytics.com/debug/mp/collect`, rebuild, reload the extension, accept the consent
card, use one feature, and read the response in the service-worker console —
the debug endpoint returns a `validationMessages` array. Expected: `[]`.
Then revert to `GA4_ENDPOINT` and rebuild.

- [ ] **Step 4: Confirm in GA4 Realtime**

Use two or three different features and confirm the event names appear in GA4
Realtime, plus one `sa_config_snapshot`. Then use another feature and confirm a
**second** snapshot does *not* appear the same day.

- [ ] **Step 5: Confirm the negative case**

Toggle counting off, use several features, and confirm nothing new arrives in
Realtime and that `usageClientId` is gone (`chrome.storage.local.get(null)` in the
worker console).

- [ ] **Step 6: Update the Chrome Web Store listing before publishing**

In the Developer Dashboard: fill the **Privacy practices** tab (the listing
currently declares that it collects no user data — that becomes false), check
**user activity**, give the justification "measuring which of the extension's own
features are used, to remove unused ones", set the **privacy policy URL** to the
published `PRIVACY.md`, make the **Limited Use** affirmation, and add the
pre-install sentence to the description:

> Optional and off by default: if you enable it in the popup, the extension counts
> which of its own features you use — the feature's name and the extension version
> only — so unused features can be removed and useful ones improved. It never sends
> URLs, organisation domains, credentials, or any document, dataset or field data.

Expect a slower review because the privacy declarations changed.

- [ ] **Step 7: Stage, and hand back for the single approved commit**

```bash
git add src/usage/ga4Config.js docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md
git status --short
```

Report to the owner: everything staged, no commit made, plus the recorded
outcomes of G1 (Task 1) and the live smoke (Steps 3–5).

---

## Self-Review

**Spec coverage.** §4 modules → Tasks 2–5. §5 payload contract → Task 2 (allowlist,
never-sent) + Task 7 (boundary test). §6 vocabulary → Task 2 `EVENT_NAMES`, wired in
Tasks 4–6. §7 config snapshot → Task 3. §8 consent UX and copy → Task 5. §9 backward
compatibility → Global Constraints + Task 1 (no permission change) + Task 3 (new keys
only) + Task 4 (`track` never throws). §10 compliance gates → Tasks 7 (PRIVACY.md) and
8 (property, declarations, G1 record). §11 how the data is read → no code; lives in the
spec. §12 testing → Tasks 2, 3, 4, 5, 6, 7 each carry their own tests, and every listed
test case appears in a step.

**Placeholder scan.** The only deliberately unfilled values are `MEASUREMENT_ID` /
`API_SECRET`, which are secrets the owner supplies in Task 8 Step 2, and the
`PRIVACY.md` event list, whose contents are mechanically derived from `EVENT_NAMES`
with a test enforcing completeness. Two call sites are located by an explicit `rg`
command rather than a line number (NetSuite/Coupa label append, Fabry deep-mode
branch) because those files were not read line-by-line while planning; the command
and the selection rule are given.

**Type consistency.** `track(name, params?)` / `trackOnce(name, params?)` used
identically in Tasks 4–6. `collect(msg, deps?)` and `setConsent(value, deps?)` match
between Task 3's implementation, its tests and the worker wiring. `buildPayload`'s
argument object (`{ name, params, clientId, sessionId, version }`) is identical in
Tasks 2 and 3. Storage key names (`usageConsent`, `usageClientId`, `usageSnapshotDay`,
`usageSessionId`) match across Tasks 3, 5, 7 and 8. `UsageCard`'s `{ consent, onAnswer }`
contract matches between Task 5's test, component and wiring.
