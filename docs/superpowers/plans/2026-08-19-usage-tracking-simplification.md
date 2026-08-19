# Usage Tracking Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the opt-in usage subsystem to one idea — a named feature was used — by deleting the daily configuration snapshot, the popup toggle events, and the parameter allowlist they were the last consumer of.

**Architecture:** Purely subtractive. The four modules (`event.js` / `collect.js` / `track.js` / `ga4Config.js`), the worker-as-only-sender boundary, and the consent flow all stay exactly as they are. No event name is renamed, so GA4's built-in Reports → Engagement → Events report stays continuous across the release. The end state is that no caller can supply a parameter at all, which turns the privacy leak-guard from a validated allowlist into a structural property.

**Tech Stack:** Vanilla ES modules, Preact (popup), Vitest, esbuild. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-usage-tracking-simplification-design.md`

## Global Constraints

- **DO NOT COMMIT. Ever, in any task.** This repo's rule (CLAUDE.md + owner's standing instruction) is that commits require explicit owner approval and a run produces exactly ONE commit. Every task below ends with `git add`, never `git commit`. This deliberately overrides the writing-plans template's per-task commit step.
- **Never rename an event name.** The 44 survivors must stay byte-identical to what ships today. GA4 offers neither rename nor backfill, so a rename orphans existing history.
- **Storage key meanings are preserved.** `usageConsent`, `usageAsked`, `usageClientId`, `usageSessionId` keep exact semantics — nobody may be re-asked or silently re-consented. `usageSnapshotDay` becomes orphaned: not migrated, not cleaned up.
- **No manifest change.** Adding any permission would disable every existing install until each user re-approves.
- **`session_id` and `engagement_time_msec` must survive.** Google requires both for user activity to reach standard reports. They are not envelope noise; deleting either stops the property counting users.
- **`tests/usage-boundary.test.js` inspects `dist/`.** If `dist/` is absent it throws. Run `npm run build` before any full-suite run.
- Test files are `.test.js` and use `h(Component, null)` rather than raw JSX (repo convention).

## File Structure

| File | Responsibility after this change |
| --- | --- |
| `src/usage/event.js` | The 44-name vocabulary + a payload builder with a fixed three-field envelope. No allowlist, no caps. |
| `src/usage/collect.js` | Worker-side: consent gate, lazy client id, session id, one fetch. No snapshot. |
| `src/usage/track.js` | `track(name)` / `trackOnce(name)` — single argument. |
| `src/usage/ga4Config.js` | Unchanged. |
| `src/popup/usageConsent.js` | Unchanged except dropping `usageSnapshotDay` from the revoke list. |
| `src/popup/components/App.jsx` | Two `track(…)` calls deleted. Nothing else. |
| `PRIVACY.md` | 44 rows; the "each event contains exactly" list becomes literally exhaustive. |
| `CLAUDE.md` | Usage section + storage-key list rewritten. |

**Non-obvious coupling that dictates task boundaries:** `tests/usage-console-events.test.js` scans every file under `src/` *except* `src/usage/event.js` for `'sa_*'` literals and requires each to be in the vocabulary. `src/usage/collect.js` contains the literal `'sa_config_snapshot'`, and `src/popup/components/App.jsx` contains `'sa_popup_toggle_on'`/`'sa_popup_toggle_off'`. So a name may only be removed from `EVENT_NAMES` **in the same task that removes its literal**, or the suite goes red between tasks. Likewise `tests/usage-boundary.test.js` asserts `PRIVACY.md` and `EVENT_NAMES` agree in both directions including an exact count, so the doc edit belongs in the same task too.

---

### Task 1: Remove the daily configuration snapshot

**Files:**
- Modify: `src/usage/event.js` (remove `sa_config_snapshot` from `EVENT_NAMES`, remove `SNAPSHOT_KEYS`, remove `buildSnapshotParams`, remove the snapshot loop that adds params to `PARAM_SPEC`)
- Modify: `src/usage/collect.js` (remove the snapshot block, its imports, `usageSnapshotDay` from `READ_KEYS`, the `today` dep)
- Modify: `src/popup/usageConsent.js:35`
- Modify: `PRIVACY.md`
- Test: `tests/usage-collect.test.js`, `tests/usage-event.test.js`, `tests/popup-usage-consent.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `src/usage/event.js` no longer exports `SNAPSHOT_KEYS` or `buildSnapshotParams`. `collect()` keeps its signature `collect(msg, deps = {}) => Promise<number>` but now returns only `0` or `1`. `defaultDeps` no longer has a `today` key.

- [ ] **Step 1: Delete the snapshot tests and rewrite the ones that assumed it**

In `tests/usage-collect.test.js`:

Delete the whole `it('emits the config snapshot once per UTC day, piggybacked on the first event', …)` block, and delete the whole `describe('a failing daily snapshot must not take the real event down with it', …)` block.

Change the serialization test so it no longer asserts a snapshot. Replace the existing `describe('concurrent events are serialized', …)` block with:

```js
describe('concurrent events are serialized', () => {
  it('mints exactly one client id for a burst', async () => {
    const d = makeDeps({ usageConsent: true });
    let seq = 0;
    d.uuid = () => `uuid-${(seq += 1)}`;
    await Promise.all([
      collect({ name: 'sa_popup_open' }, d),
      collect({ name: 'sa_rossum_schema_ids' }, d),
      collect({ name: 'sa_console_open' }, d),
    ]);
    expect(d.sent).toHaveLength(3);
    const ids = new Set(d.sent.map((s) => s.body.client_id));
    expect(ids.size).toBe(1);
    expect(d.local.usageClientId).toBe('uuid-1');
  });
});
```

In the same file, remove `usageSnapshotDay: '2026-08-03'` from every `makeDeps({ … })` call (there are seven), and remove the `today: () => '2026-08-03',` line from the `makeDeps` helper.

In `tests/usage-event.test.js`: delete the `it('maps stored toggles to 0/1 snapshot params', …)` and `it('accepts the snapshot event with all eight booleans', …)` blocks, and change the import to drop `SNAPSHOT_KEYS` and `buildSnapshotParams`:

```js
import { EVENT_NAMES, buildPayload } from '../src/usage/event.js';
```

In `tests/popup-usage-consent.test.js`, replace the revoke assertion:

```js
  it('revoking drops the identifier too', async () => {
    const d = makeDeps();
    await writeConsent(false, d);
    expect(d.calls).toContainEqual(['set', { usageConsent: false }]);
    expect(d.calls).toContainEqual(['remove', ['usageClientId']]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/usage-collect.test.js tests/usage-event.test.js tests/popup-usage-consent.test.js`

Expected: FAIL. `popup-usage-consent` fails on the `['usageClientId']` assertion (the code still removes two keys). `usage-collect` fails because `collect()` still returns `2` on a fresh profile and still posts a snapshot.

- [ ] **Step 3: Remove the snapshot from `src/usage/event.js`**

Delete the `sa_config_snapshot` entry and the `// Configuration` comment above it from `EVENT_NAMES`. Delete the entire `SNAPSHOT_KEYS` export and its comment. Delete the entire `buildSnapshotParams` function. Delete this loop, which existed only to admit the snapshot's 0/1 flags:

```js
for (const param of Object.keys(SNAPSHOT_KEYS)) {
  PARAM_SPEC[param] = (v) => v === 0 || v === 1;
}
```

- [ ] **Step 4: Remove the snapshot from `src/usage/collect.js`**

Change the imports to:

```js
import { buildPayload, EVENT_NAMES } from './event.js';
import { GA4_ENDPOINT, MEASUREMENT_ID, API_SECRET } from './ga4Config.js';
```

Delete the `today:` line from `defaultDeps`. Change `READ_KEYS` to:

```js
// Deliberately an explicit key list, never getLocal(null): the local store also
// holds staged consoleAuth_* entries carrying session tokens, and this module
// has no business reading them.
const READ_KEYS = ['usageConsent', 'usageClientId'];
```

In `collectOne`, delete the whole `const day = d.today();` / `if (stored.usageSnapshotDay !== day) { … }` block and the `if (name !== 'sa_config_snapshot')` guard, replacing the tail of the function body with:

```js
    await post(d, name, msg.params || {}, clientId);
    return 1;
  } catch {
    return 0;
  }
}
```

Also delete the `let sent = 0;` line. Then update the comment above `let queue = Promise.resolve();` so it no longer claims a daily-snapshot marker as a reason, and instead reads:

```js
// Serialized: collect() is a check-then-act read-modify-write across an await
// (the lazy client id). A burst of events in one tick would otherwise each
// observe pre-state and mint several ids, sending events under different
// identifiers. This looks deletable now that the daily snapshot is gone — it is
// not. The queue never rejects; collectOne already swallows.
```

- [ ] **Step 5: Drop the orphaned key from `src/popup/usageConsent.js`**

Change line 35 from `d.removeLocal(['usageClientId', 'usageSnapshotDay'])` to:

```js
  const removed = d.removeLocal(['usageClientId']);
```

Update the file's header comment, which currently mentions the snapshot marker, so it does not reference a key that no longer exists.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/usage-collect.test.js tests/usage-event.test.js tests/popup-usage-consent.test.js`

Expected: PASS.

- [ ] **Step 7: Update `PRIVACY.md`**

Change line 3 to `Last updated: 2026-08-19`.

Delete this bullet (line 34):

```
- for the once-a-day configuration event, one 0/1 flag per feature toggle.
```

Delete the entire Configuration block near line 139 — the `**Configuration**` heading, the blank line, the table header, the separator row, and the `sa_config_snapshot` row.

- [ ] **Step 8: Verify the vocabulary and the document still agree**

Run: `npx vitest run tests/usage-boundary.test.js tests/usage-console-events.test.js`

Expected: PASS. If `usage-boundary` throws about `dist/`, run `npm run build` first. If `usage-console-events` fails with `sa_config_snapshot`, a literal survived in `src/usage/collect.js` — remove it.

- [ ] **Step 9: Stage (DO NOT COMMIT)**

```bash
git add src/usage/event.js src/usage/collect.js src/popup/usageConsent.js PRIVACY.md tests/usage-collect.test.js tests/usage-event.test.js tests/popup-usage-consent.test.js
```

---

### Task 2: Remove the popup toggle events

**Files:**
- Modify: `src/popup/components/App.jsx:203`, `src/popup/components/App.jsx:234`
- Modify: `src/usage/event.js` (remove two names, `TOGGLE_FEATURES`, the `feature` validator)
- Modify: `PRIVACY.md`
- Test: `tests/usage-event.test.js`

**Interfaces:**
- Consumes: `src/usage/event.js` from Task 1 (no `SNAPSHOT_KEYS`, no `buildSnapshotParams`).
- Produces: `src/usage/event.js` no longer exports `TOGGLE_FEATURES`. `EVENT_NAMES.length === 44`.

- [ ] **Step 1: Delete the test that pins the `feature` enum**

In `tests/usage-event.test.js`, delete the whole `it('rejects a feature value outside the toggle enum', …)` block. Add this assertion to the `describe('usage event vocabulary', …)` block so the count is pinned deliberately rather than by accident:

```js
  it('carries exactly the 44 names PRIVACY.md publishes', () => {
    expect(EVENT_NAMES).toHaveLength(44);
  });

  it('no longer reports configuration changes, only use', () => {
    for (const gone of ['sa_config_snapshot', 'sa_popup_toggle_on', 'sa_popup_toggle_off']) {
      expect(EVENT_NAMES).not.toContain(gone);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/usage-event.test.js`

Expected: FAIL — `EVENT_NAMES` still has 46 entries at this point and still contains both toggle names.

- [ ] **Step 3: Remove the two call sites**

In `src/popup/components/App.jsx`, delete line 203 in `setStorageToggle`:

```js
    track(value ? 'sa_popup_toggle_on' : 'sa_popup_toggle_off', { feature: key });
```

and line 234 in `setMessageToggle`:

```js
      track(next ? 'sa_popup_toggle_on' : 'sa_popup_toggle_off', { feature: key });
```

Leave the surrounding functions otherwise untouched, and leave the `import { track }` — `sa_popup_open`, `sa_popup_experimental_unlock` and the unlock banner still use it. Verify with `grep -n "track(" src/popup/components/App.jsx`, which must still show the `sa_popup_open` and `sa_popup_experimental_unlock` calls.

- [ ] **Step 4: Remove the names and the enum from `src/usage/event.js`**

Delete the `sa_popup_toggle_on` and `sa_popup_toggle_off` entries from `EVENT_NAMES` (keep `sa_popup_open`, `sa_popup_experimental_unlock` and `sa_popup_unlock_annotation`). Delete the entire `TOGGLE_FEATURES` export and its comment. Delete the `feature:` line from `PARAM_SPEC`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/usage-event.test.js tests/usage-console-events.test.js`

Expected: PASS. A failure in `usage-console-events` naming a toggle event means a literal survived in `App.jsx`.

- [ ] **Step 6: Update `PRIVACY.md`**

Delete these two rows from the popup table (lines 87–88):

```
| `sa_popup_toggle_on` | you switched a feature on (carries which toggle, from a fixed list of the nine toggle names) |
| `sa_popup_toggle_off` | you switched a feature off (same fixed list) |
```

- [ ] **Step 7: Verify the document and vocabulary agree**

Run: `npx vitest run tests/usage-boundary.test.js`

Expected: PASS — the exact-count assertion now compares 44 against 44.

- [ ] **Step 8: Stage (DO NOT COMMIT)**

```bash
git add src/popup/components/App.jsx src/usage/event.js PRIVACY.md tests/usage-event.test.js
```

---

### Task 3: Delete the parameter allowlist

**Files:**
- Modify: `src/usage/event.js` (remove `PARAM_SPEC`, `NAME_RE`, the 25-param cap, the 130KB cap; `buildPayload` loses its `params` argument)
- Modify: `src/usage/track.js` (`track` and `trackOnce` become single-argument)
- Modify: `src/usage/collect.js` (`post` stops forwarding `msg.params`)
- Test: `tests/usage-event.test.js`, `tests/usage-track.test.js`, `tests/usage-collect.test.js`

**Interfaces:**
- Consumes: `src/usage/event.js` from Task 2 (44 names, no `TOGGLE_FEATURES`).
- Produces: `buildPayload({ name, clientId, sessionId, version }) => { client_id, events: [{ name, params }] }` where `params` is always `{ session_id, engagement_time_msec: 1 }` plus `ext_ver` when `version` is a usable string. `track(name)` and `trackOnce(name)` take exactly one argument.

- [ ] **Step 1: Rewrite the payload tests**

In `tests/usage-event.test.js`, delete these three blocks entirely: `it('rejects a param key that is not allowlisted — the leak guard', …)`, `it('rejects Object.prototype keys — they must not resolve to inherited validators', …)`, and `it('rejects a missing client id and an over-long version', …)`.

Add in their place:

```js
  it('ignores any params a caller passes — there is no field for them', () => {
    const body = buildPayload({
      ...base, name: 'sa_popup_open', params: { org: 'acme', page_location: 'https://x' },
    });
    expect(body.events[0].params).toEqual({
      ext_ver: 'abc1234', session_id: 's1', engagement_time_msec: 1,
    });
  });

  it('rejects a missing client id', () => {
    expect(() => buildPayload({ ...base, clientId: '', name: 'sa_popup_open' })).toThrow(/clientId/);
  });

  it('omits an unusable version rather than dropping the whole event', () => {
    // A throw here would lose a real feature-use event over a cosmetic field.
    const body = buildPayload({ ...base, version: 'v'.repeat(101), name: 'sa_popup_open' });
    expect(body.events[0].params).toEqual({ session_id: 's1', engagement_time_msec: 1 });
  });
```

Note: the existing `it('every name satisfies GA4 naming rules', …)` test already asserts `/^[a-z][a-z0-9_]{0,39}$/` over `EVENT_NAMES`. Leave it — it is what makes deleting the runtime `NAME_RE` safe, because a closed literal list is checkable once at build time.

- [ ] **Step 2: Rewrite the track test**

In `tests/usage-track.test.js`, replace `it('includes params only when given', …)` with:

```js
  it('never puts params on the message, even when a caller passes one', async () => {
    const { track } = await freshTrack();
    track('sa_popup_open', { feature: 'scrollLockEnabled' });
    expect(sent).toEqual([{ type: 'sa-usage', name: 'sa_popup_open' }]);
  });
```

- [ ] **Step 3: Rewrite the stray-params collect test**

In `tests/usage-collect.test.js`, replace `it('drops an event carrying a non-allowlisted param instead of throwing', …)` with:

```js
  it('ignores stray params on the message — an old surface cannot leak through', async () => {
    // After an upgrade an orphaned content script can still post the old message
    // shape. The params must be dropped, not forwarded, and not fatal.
    const d = makeDeps({ usageConsent: true, usageClientId: 'c1' });
    expect(await collect({ name: 'sa_popup_open', params: { org: 'acme' } }, d)).toBe(1);
    expect(d.sent[0].body.events[0].params).toEqual({
      ext_ver: 'abc1234', session_id: 'uuid-1', engagement_time_msec: 1,
    });
  });
```

Move this test out of the `describe('consent gate', …)` block into the `describe('sending', …)` block, since it now asserts a send rather than a drop.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/usage-event.test.js tests/usage-track.test.js tests/usage-collect.test.js`

Expected: FAIL — `buildPayload` still throws `param not allowed: org`, and `track` still copies params onto the message.

- [ ] **Step 5: Rewrite `buildPayload` in `src/usage/event.js`**

Delete `const NAME_RE = …`, the whole `PARAM_SPEC` object, and replace `buildPayload` with:

```js
// Every event carries exactly these three fields and nothing else, so there is
// no field in the payload that feature-specific data could travel in. The leak
// guard is structural now, not a validated allowlist.
//
// session_id and engagement_time_msec are NOT decoration: Google requires both
// for user activity to reach GA4's standard reports, so removing either stops
// the property counting users.
export function buildPayload({ name, clientId, sessionId, version }) {
  if (!EVENT_NAMES.includes(name)) throw new Error(`unknown event name: ${name}`);
  if (!isStr100(clientId)) throw new Error('clientId required');

  const params = { session_id: sessionId, engagement_time_msec: 1 };
  // Omitted rather than rejected: a bad manifest read must not cost a real
  // feature-use event.
  if (isStr100(version)) params.ext_ver = version;

  // No param-count or payload-size guard. Both were real GA4 limits (25 params,
  // 130KB) and both are now unreachable by construction: the body is a 36-char
  // uuid, one name of at most 40 characters, and these three fields — roughly
  // 250 bytes. Restoring either would guard nothing.
  return { client_id: clientId, events: [{ name, params }] };
}
```

Keep `const isStr100 = …` where it is. Then update the module header comment: it currently claims the module "stays importable from ANY surface without dragging the analytics host into that surface's bundle", which protects a hypothetical — verified 2026-08-19, nothing under `src/` imports this file. Replace that clause with a statement that the endpoint lives in `ga4Config.js` so the worker's bundle is the only one naming the host, and add a line recording that every event is now just a name.

**Do NOT lose this sentence while rewriting the comment:**

> Adding a feature event means adding its name HERE and to PRIVACY.md, which publishes this list so the privacy claim is auditable rather than trusted (tests/usage-boundary.test.js enforces that).

It is the only place a future author is told that the document is part of the change. Task 4 adds the machine-checked half; this sentence is the human-readable half, and the two are not redundant.

- [ ] **Step 6: Make `track` single-argument in `src/usage/track.js`**

```js
export function track(name) {
  if (consentKnown === false) return undefined;
  try {
    const p = chrome.runtime.sendMessage({ type: 'sa-usage', name });
    // No receiver (worker asleep mid-teardown, page closing) rejects; ignore.
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // chrome.runtime missing, or this context is being torn down.
  }
  return undefined;
}

// For features driven by the MutationObserver: they act per DOM node, so this
// collapses a whole page's activity into one event. The set lives for the
// content script instance, i.e. one page load.
export function trackOnce(name) {
  if (sentOnce.has(name)) return undefined;
  sentOnce.add(name);
  return track(name);
}
```

Also update the module's opening comment, which describes the worker as validating "the name and params".

- [ ] **Step 7: Stop forwarding params in `src/usage/collect.js`**

Change `post` to:

```js
async function post(d, name, clientId) {
  const body = buildPayload({
    name, clientId, sessionId: await sessionId(d), version: d.version(),
  });
  await d.fetch(d.endpoint(), { method: 'POST', body: JSON.stringify(body) });
}
```

and its call site in `collectOne` to `await post(d, name, clientId);`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/usage-event.test.js tests/usage-track.test.js tests/usage-collect.test.js`

Expected: PASS.

- [ ] **Step 9: Stage (DO NOT COMMIT)**

```bash
git add src/usage/event.js src/usage/track.js src/usage/collect.js tests/usage-event.test.js tests/usage-track.test.js tests/usage-collect.test.js
```

---

### Task 4: Keep PRIVACY.md honest by construction

**Files:**
- Test: `tests/usage-boundary.test.js`

**Interfaces:**
- Consumes: `buildPayload` from Task 3 (fixed three-field envelope) and the 44-name `EVENT_NAMES`.
- Produces: nothing code-facing. This task adds guards only.

**Why this task exists:** `PRIVACY.md` states that each event is one request "containing exactly" four things — the name, the extension version, a random client identifier and a random session identifier. Until Task 3 that sentence was self-evidently true because `PARAM_SPEC` was a visible allowlist any reviewer would notice. With the allowlist deleted, **nothing in the suite pins the payload shape**, so a future fourth field would silently make a published privacy policy false. The name-pairing assertions already in this file do not catch that — they only check names.

- [ ] **Step 1: Import the payload builder into the boundary test**

In `tests/usage-boundary.test.js`, change the import:

```js
import { EVENT_NAMES, buildPayload } from '../src/usage/event.js';
```

- [ ] **Step 2: Pin the payload shape to the document's promise**

Add this inside the existing `describe('PRIVACY.md', …)` block, so the doc-sync assertions own it:

```js
  // PRIVACY.md promises each event contains EXACTLY: the event name, the
  // extension version, a random client identifier and a random per-session
  // identifier. That is a promise about the payload, and after 2026-08-19
  // nothing else pins it — the parameter allowlist that used to make it
  // self-evident was deleted, because no caller can supply a param any more.
  // If this fails, the payload gained or lost a field and the "containing
  // exactly" list in PRIVACY.md is now FALSE. Fix the document, not the
  // assertion.
  it('sends exactly the fields PRIVACY.md promises, for every event', () => {
    for (const name of EVENT_NAMES) {
      const body = buildPayload({
        name, clientId: 'c1', sessionId: 's1', version: 'abc1234',
      });
      expect(Object.keys(body).sort()).toEqual(['client_id', 'events']);
      expect(body.events).toHaveLength(1);
      expect(Object.keys(body.events[0]).sort()).toEqual(['name', 'params']);
      expect(Object.keys(body.events[0].params).sort())
        .toEqual(['engagement_time_msec', 'ext_ver', 'session_id']);
    }
  });
```

- [ ] **Step 3: Tighten the name-publication check**

Replace the existing `it('publishes every event name so the claim is auditable', …)` block with:

```js
  it('publishes every event name in backticks, so the list is a real list', () => {
    // The looser `text.includes(name)` would accept a name buried in prose or
    // appearing only as a substring of a longer name. The document IS the
    // published vocabulary, so every name must appear as code.
    expect(EVENT_NAMES.filter((n) => !text.includes(`\`${n}\``))).toEqual([]);
  });
```

- [ ] **Step 4: Run the tests — expect PASS, not FAIL**

Run: `npx vitest run tests/usage-boundary.test.js`

Expected: PASS. These are guard tests over behaviour Tasks 1–3 already made correct, so there is no red phase. That is exactly why Step 5 exists.

- [ ] **Step 5: Prove the guard can actually fail**

A guard test that cannot fail is a tautology, and this repo already treats that as a defect worth a dedicated assertion (see `tests/usage-console-events.test.js`, "actually skips the vocabulary file — otherwise these tests are tautologies"). So verify both new guards by breaking them on purpose and reverting.

First, temporarily add a fourth field in `src/usage/event.js` inside `buildPayload`:

```js
  const params = { session_id: sessionId, engagement_time_msec: 1, debug_mode: 1 };
```

Run: `npx vitest run tests/usage-boundary.test.js`
Expected: FAIL on "sends exactly the fields PRIVACY.md promises, for every event".

**Revert that line** back to `const params = { session_id: sessionId, engagement_time_msec: 1 };`.

Then temporarily add a bogus name to `EVENT_NAMES`, e.g. `'sa_not_in_the_doc',`.

Run: `npx vitest run tests/usage-boundary.test.js`
Expected: FAIL on both "publishes every event name in backticks" and the exact-count assertion.

**Revert that line too.**

- [ ] **Step 6: Confirm the file is back to its Task 3 state**

```bash
git diff src/usage/event.js | grep -E "^\+.*(debug_mode|sa_not_in_the_doc)" && echo "LEFTOVER MUTATION — revert it" || echo "clean"
npx vitest run tests/usage-boundary.test.js
```

Expected: `clean`, then PASS.

- [ ] **Step 7: Stage (DO NOT COMMIT)**

```bash
git add tests/usage-boundary.test.js
```

---

### Task 5: Update `CLAUDE.md` and verify the whole thing

**Files:**
- Modify: `CLAUDE.md:1338` (storage-key list), `CLAUDE.md:1340`–`1352` (the "Usage data (opt-in)" section)
- Test: the full suite, against a fresh build

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing code-facing.

- [ ] **Step 1: Rewrite the storage-key bullet**

In `CLAUDE.md` line 1338, remove the `usageSnapshotDay` clause from the live-key description and add it to the orphaned list, matching how the file already documents `trainingUnlocked`, `fabryArchSplitRatio` and the removed popup toggles. The bullet must end up naming exactly four live keys: `usageConsent`, `usageClientId`, `usageAsked` (local) and `usageSessionId` (session), and must state that `usageSnapshotDay` is orphaned as of 2026-08-19 — never migrated, never cleaned up, read by nothing.

- [ ] **Step 2: Rewrite the "Usage data (opt-in)" section**

Update these bullets in `CLAUDE.md:1340`–`1352`:

- **`src/usage/event.js`** — describe it as the closed vocabulary of **44** names plus a fixed three-field payload. State that there is no param allowlist because no caller can supply a param, and that this makes the leak guard structural. Record why `session_id`/`engagement_time_msec` cannot be removed (Google requires both for user activity in standard reports) and why the 25-param and 130KB caps were deleted (unreachable by construction).
- **`src/usage/track.js`** — change the signature to `track(name)` / `trackOnce(name)`.
- **`src/usage/collect.js`** — delete the sentence about the daily `sa_config_snapshot` piggybacking on the first event of the day. Keep the `chrome.alarms` reasoning **only** if it is rewritten as history, since nothing schedules anything now; simpler is to delete it. Add a line saying the serialized queue is still required by the lazy client-id mint and must not be deleted as dead weight.
- Add a line recording what was given up: "enabled but never used" is no longer distinguishable from "never discovered", and `devFeaturesEnabled`/`devDebugEnabled` are now completely unmeasured because they are page flags with no use-event of their own.
- Point at `docs/superpowers/specs/2026-08-19-usage-tracking-simplification-design.md`.

**`README.md` needs NO edit.** Its usage section already says the extension "sends the feature's name and the extension version", which this change makes more literally true, not less. Do not touch it.

- [ ] **Step 3: Build, then run the entire suite**

```bash
npm run build && npm test
```

Expected: PASS, with no failures anywhere. `tests/usage-boundary.test.js` needs the fresh `dist/` this command produces; it asserts both that `dist/background.js` ships the analytics host and that no other bundle does.

- [ ] **Step 4: Confirm the end state matches the spec's numbers**

```bash
node -e "
const s=require('fs').readFileSync('src/usage/event.js','utf8');
const n=[...s.match(/EVENT_NAMES = \[([\s\S]*?)\n\];/)[1].matchAll(/'([a-z0-9_]+)'/g)].map(x=>x[1]);
console.log('names:', n.length, '(expect 44)');
console.log('PARAM_SPEC gone:', !/PARAM_SPEC/.test(s));
console.log('TOGGLE_FEATURES gone:', !/TOGGLE_FEATURES/.test(s));
console.log('SNAPSHOT_KEYS gone:', !/SNAPSHOT_KEYS/.test(s));
"
grep -rn "usageSnapshotDay" src/ tests/ || echo "usageSnapshotDay: no references in src/ or tests/ — correct"
grep -rnE "track(Once)?\([^)]*,[^)]*\)" src/ --include='*.js' --include='*.jsx' | grep -v useOperationStatus | grep -v IndexPanel | grep -v SearchIndexPanel || echo "no track() call passes a second argument — correct"
```

Expected: `names: 44`, all three `gone:` lines `true`, and both `grep` fallbacks printing their "correct" message.

- [ ] **Step 5: Stage (DO NOT COMMIT)**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-19-usage-tracking-simplification-design.md docs/superpowers/plans/2026-08-19-usage-tracking-simplification.md
git status --short
```

Then STOP and report to the owner. Do not run `git commit` — the owner approves and takes exactly one commit per run.

Include in the report the one follow-up this plan cannot do, because it lives in the GA4 UI and not in this repo: the 8 custom metrics (`schema_ids`, `resource_ids`, `expand_formulas`, `expand_reasoning`, `scroll_lock`, `netsuite_fields`, `coupa_fields`, `experimental`) and the `feature` custom dimension stop receiving data and may be archived. `ext_ver` stays live. Nothing breaks if this is never done — the caps are 50 and 50.
