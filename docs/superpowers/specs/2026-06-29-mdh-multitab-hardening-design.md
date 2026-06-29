# MDH Multi-Tab Hardening — Design

**Date:** 2026-06-29
**Status:** Approved (pending implementation plan)

## Problem

The Console (MDH) is a Preact SPA. Each `console/console.html` tab is its own
browsing context, so all module state (signals, in-memory cache, API client,
`pipelineState` Map, prefetch controllers, poll timers) and `sessionStorage`
(the auth token) are **per-tab**. The only surface shared across tabs is
`chrome.storage.local`. No code subscribes to `chrome.storage.onChanged`
(verified: `grep -rn "onChanged" src/` → 0 hits), so tabs never live-sync.

That makes runtime fully isolated — multiple tabs (even different orgs) work
correctly in the same session. The remaining rough edges are confined to the
shared-storage layer and surface only on **reload / new tab**:

1. **View-state drift.** Global, non-org-scoped keys (`mdhSelectedCollection`,
   `mdhActiveView`, `mdhActivePanel`, `consoleActiveApp`, `mdhOpsSearch`) are
   written by every tab via `effect()`s — last-writer-wins. A reloaded tab
   restores whatever another tab wrote last, not its own working context.

2. **Pipeline/collection mismatch.** `mdhLastPipeline` is keyed per-org but
   **not** per-collection (`src/mdh/lastPipeline.js:6`). Same-org tabs overwrite
   each other's last pipeline. On reload, `bootPrefillFor` can pair the restored
   collection (a global key) with a pipeline authored for a different collection,
   so an aggregation written for collection A runs against collection B
   (backend error or 0 rows — handled, but confusing).

3. **History write race.** `addToHistory` / `saveQuery` / `unsaveQuery`
   (`src/mdh/components/QueryHistory.jsx`) do an unguarded
   read-modify-write on a per-org array. Two concurrent writers lose an update.

## Goals

- A reloaded tab keeps its own working context; tabs don't clobber each other.
- A freshly-opened tab still resumes where the user last was (no regression for
  the common single-tab workflow).
- The restored pipeline always matches the restored collection.
- History writes don't lose entries within a tab.
- **Backward compatible:** existing `chrome.storage.local` keys keep working as
  the cross-session seed; no migration step is required of the user.

## Non-goals

- Live cross-tab synchronization (no `onChanged` wiring) — out of scope; the
  per-tab isolation model is intentional.
- Making layout/preference state per-tab. Layout widths (`mdhPipelineWidth`,
  `mdhSidebarWidth`, `mdhUploadsColumnWidths`), `mdhResultsView`, Stages options
  (`mdhStagesAutoscroll`, `mdhStagesSampleSize`), and `mdhOverviewChartsScale`
  stay **global** — they are genuine preferences the user wants consistent
  across tabs and restarts; their drift is harmless.
- Eliminating the cross-tab history-write race (two tabs writing within ~ms).
  Accepted as a documented, low-probability residual.

## Design

### Part A — Per-tab navigation state (session-first, local-seed)

New module **`src/console/tabState.js`** (pure helpers in the style of
`src/console/boot.js`):

```js
// Keys whose value is per-tab working context (not a global preference).
export const TAB_SCOPED_KEYS = [
  'consoleActiveApp',
  'mdhActiveView',
  'mdhSelectedCollection',
  'mdhActivePanel',
  'mdhOpsSearch',
];

function readSession(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

// Pure + testable: start from the chrome.storage.local values already fetched
// at boot, then let any per-tab sessionStorage value override. Returns a plain
// object of resolved values for the requested keys.
export function resolveTabState(keys, localValues) {
  const out = {};
  for (const key of keys) {
    const s = readSession(key);
    out[key] = s !== undefined ? s : localValues[key];
  }
  return out;
}

// Write a per-tab value to BOTH surfaces: sessionStorage (authoritative for
// this tab on reload) + chrome.storage.local (cross-session seed for the next
// fresh tab). Best-effort; a storage hiccup must never break navigation.
export function writeTabState(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {}
  try { chrome.storage.local.set({ [key]: value }); } catch {}
}
```

**Read model (boot):** prefer `sessionStorage[key]`; fall back to the
`chrome.storage.local[key]` already fetched.
**Write model (on change):** write to *both* surfaces.

Resulting behavior:
- **Tab reload** → reads its own `sessionStorage` → keeps its collection/view.
- **Brand-new tab** (empty `sessionStorage`) → falls back to
  `chrome.storage.local` → resumes the last globally-written context.
- **Single-tab user** → unchanged (session and local always agree).

**Wiring** (each tab-scoped key has exactly one reader at boot and one writer
`effect`, verified):

- `src/console/index.jsx`
  - Boot: resolve `consoleActiveApp` session-first before `pickInitialApp`
    (~line 103): `resolveTabState(['consoleActiveApp'], stored)['consoleActiveApp']`
    becomes `persistedApp`. Staging `app` still wins (unchanged precedence).
  - Write effect (line 145): `writeTabState('consoleActiveApp', activeApp.value)`.

- `src/mdh/index.jsx` (`initMdh`)
  - After the existing `chrome.storage.local.get([...])`, resolve the four MDH
    tab-scoped keys session-first via `resolveTabState` and apply them to the
    signals (replacing the direct `stored.*` reads at ~lines 129-140).
  - Change the four write effects to `writeTabState`:
    - `mdhActiveView` (line 192)
    - `mdhSelectedCollection` (line 196)
    - `mdhActivePanel` (line 199)
    - `mdhOpsSearch` (line 208)
  - `mdhStagesAutoscroll` (202) and `mdhStagesSampleSize` (205) stay
    `chrome.storage.local.set` (global preferences).

The existing `Sidebar.loadCollections` guard
(`src/mdh/components/Sidebar.jsx:18-23`) already nulls a restored collection
that isn't in the current org's list and falls back to the first collection, so
the cross-org seed case is handled without new code.

### Part B — Collection-scoped `mdhLastPipeline`

`src/mdh/lastPipeline.js`:

```js
export function lastPipelineKey(collection) {
  return `mdhLastPipeline::${scopeSuffix()}::${collection || ''}`;
}
export function saveLastPipeline(collection, pipelineText, variables, placeholderTypes) { … }
```

- `src/mdh/components/DataPanel.jsx:369` passes `collection`
  (it already has `const collection = selectedCollection.value`).
- `initMdh` resolves the selected collection **first** (Part A), then does a
  second small `chrome.storage.local.get(lastPipelineKey(collection))` to fetch
  that collection's pipeline. `bootPrefillFor` is unchanged.

With selected-collection per-tab **and** the pipeline keyed by collection, the
mismatch disappears: each tab restores its own collection and that collection's
pipeline. Two tabs on the same collection share that collection's last pipeline
(last-writer-wins, but same collection → never a mismatch). The key stays in
`chrome.storage.local`, so per-collection pipelines now survive a browser
restart (a small bonus).

**Migration (legacy key): orphan it.** Existing users have a legacy
`mdhLastPipeline::<scope>` entry (no collection segment). The new code never
reads it. We deliberately do **not** read or migrate it: on the first boot after
upgrade the single global "last pipeline" isn't restored for one session; the
user re-runs it once and the new per-collection key takes over. This avoids
re-introducing the A-pipeline-on-B-collection mismatch we're fixing. The stale
key is a single small orphan (no cleanup code required; may optionally be added
to a future stale-sweep — not in scope here).

### Part C — In-page serialized history writes

`src/mdh/components/QueryHistory.jsx`: a per-tab promise-chain mutex wrapping the
three read-modify-write functions.

```js
let writeChain = Promise.resolve();
function serialize(task) {
  const run = writeChain.then(task, task); // run regardless of prior outcome
  writeChain = run.catch(() => {});
  return run;
}
```

`addToHistory`, `saveQuery`, `unsaveQuery` each run their entire
read-modify-write inside `serialize(async () => { … })`. Rapid successive writes
within a tab can no longer interleave and lose entries. Same keys, same entry
shapes → fully backward-compatible. The cross-tab residual (two tabs writing
within ~ms) is accepted and documented.

## Data flow (after)

- **Boot:** `chrome.storage.local.get` global + tab-scoped keys →
  `resolveTabState` overlays `sessionStorage` → signals set →
  `lastPipelineKey(collection)` fetched → `bootPrefillFor`.
- **On change:** tab-scoped signal changes → `writeTabState` (session + local);
  global preference changes → `chrome.storage.local.set` (unchanged); editor
  edit → debounced `saveLastPipeline(collection, …)`.

## Error handling

- All `sessionStorage` / `chrome.storage.local` access is wrapped in try/catch
  (matches existing best-effort persistence; a storage hiccup never breaks
  navigation or editing).
- `JSON.parse` failure in `readSession` → `undefined` → falls back to the local
  value (or default).

## Testing (TDD)

New/updated vitest specs (`.test.js`, `h()`-render convention):

- `tabState.test.js` — `resolveTabState`: session overrides local; missing
  session → local; missing both → `undefined`/passthrough. `writeTabState`:
  writes both surfaces (mock `sessionStorage` + `chrome.storage.local`).
- `lastPipeline.test.js` — `lastPipelineKey(collection)`: distinct collections →
  distinct keys; empty/undefined collection tolerated; scope suffix still
  applied. `bootPrefillFor` unchanged behavior preserved.
- `QueryHistory` serialize test — two concurrent `addToHistory` calls against a
  mock `chrome.storage.local` whose get/set is artificially delayed → both
  entries survive (fails today; passes after the mutex).

Full suite (`npm test`) must stay green (capture the baseline count before
changes); `npm run build` must succeed.

## Files touched

- **New:** `src/console/tabState.js` (+ test)
- `src/console/index.jsx` — `consoleActiveApp` session-first + `writeTabState`
- `src/mdh/index.jsx` — resolve 4 MDH nav keys session-first; `writeTabState`;
  fetch collection-scoped last pipeline after collection resolved
- `src/mdh/lastPipeline.js` — `lastPipelineKey(collection)` + `saveLastPipeline`
  signature (+ test)
- `src/mdh/components/DataPanel.jsx` — pass `collection` to `saveLastPipeline`
- `src/mdh/components/QueryHistory.jsx` — `serialize` mutex (+ test)
- `CLAUDE.md` — document per-tab keys + new `mdhLastPipeline` shape in the
  "Chrome Storage Keys" section and the auth/boot description

## Backward compatibility summary

- Existing `chrome.storage.local` keys remain the cross-session seed → no user
  migration; single-tab behavior is identical.
- `mdhLastPipeline` legacy key is orphaned (one-time, one-entry, no crash).
- History keys/shapes unchanged.
- No new permissions, no new manifest entries, no service-worker changes.
