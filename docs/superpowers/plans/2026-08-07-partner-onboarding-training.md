# Partner Onboarding Training Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gated, gamified onboarding track to the extension that guides an implementation partner through Rossum, verifies each step from the URL or read-only API state, and issues a per-person completion receipt we can validate offline.

**Architecture:** A dependency-free pure core in `src/training/` (curriculum data, step evaluation, baseline deltas, progress/XP math, receipt) is bundled into **both** the Rossum content script and the Console, each injecting its own `get(path)`. The content script renders a bottom-right quest card plus a pointer arrow and evaluates steps continuously; the Console's new Academy app renders the mission map, teaching text, the receipt and a trainer validation panel. Progress crosses surfaces through `chrome.storage.local`, not messaging.

**Tech Stack:** Preact + `@preact/signals` (Console), plain DOM (content script), esbuild, Vitest + jsdom, `crypto.subtle` HMAC-SHA256, CSS Modules for Console components.

**Spec:** `docs/superpowers/specs/2026-08-07-partner-onboarding-training-design.md` — read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section.

- **DO NOT RUN `git commit`.** Owner rule: work is left **staged** and the owner commits explicitly at the end, as a single commit. Each task ends with `git add`, never `git commit`. Never add a `Co-Authored-By` trailer.
- **No manifest changes.** `manifest.json` permissions stay `["storage","activeTab","scripting","sidePanel"]` and `host_permissions` unchanged. Adding a permission disables every existing install until each user re-approves.
- **The extension never writes to the trainee's org.** Every verification is a GET. No POST/PATCH/PUT/DELETE against Rossum anywhere in this feature.
- **Baselines and receipts carry no org content.** Baseline values are integers or `\d+:\d+` id pairs only — never names, schema-field ids, collection names or document data.
- **Tests:** `npm test` runs `vitest run`; a single file is `npx vitest run tests/<file>.test.js`. Tests live in `tests/*.test.js`.
- **No JSX in `.test.js` files** — oxc only transforms `.jsx`. Render components with `h(Component, props)`.
- **No fixed-timeout waits in tests.** Use a condition-based `waitFor` (copy the helper from `tests/popup-reviewing-lock-banner.test.js`).
- **Unicode in JSX:** `\uXXXX` does not work in JSX text or attribute values. Write `{'→'}`, the literal character, or an HTML entity.
- **Content-script CSS** is injected from `init()`, all classes prefixed `rossum-sa-extension-`, built with `document.createElement` + `textContent` — never `innerHTML` (Trusted-Types-safe pages).
- **Console CSS** goes in a component-owned `*.module.css` (esbuild emits `dist/console/console.css`); do not add rules to `src/console/console.css`.
- **After any UI change run `npm run build`** — tests run `src/`, but the loaded extension runs `dist/`. Reloading the extension does **not** re-inject content scripts into open Rossum tabs; the tab must be reloaded once.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/training/track.js` | Curriculum **data** only — missions, steps, hints, teaching text |
| `src/training/progress.js` | Pure progress state: merge, XP/levels, linear unlock, version migration |
| `src/training/baseline.js` | Pure baseline signatures + delta predicates |
| `src/training/steps.js` | Pure step evaluation (`visit` via `detectResource`, `api` via named checks) |
| `src/training/receipt.js` | Pure canonical string, code formatting, receipt render + strict parse |
| `src/training/hmac.js` | The only `crypto.subtle` caller |
| `src/training/receiptKey.js` | The HMAC secret, isolated — nothing else may name it |
| `src/training/storage.js` | `chrome.storage.local` keys, read/write, org pruning |
| `src/training/gate.js` | `trainingUnlocked` read + `onChanged` subscription |
| `src/rossum/api.js` | *(modify)* add `fetchRossumApiFresh`, widen the path allowlist by one prefix |
| `src/rossum/features/training-quest.js` | The corner card, the polling loop, step advancement |
| `src/rossum/features/training-pointer.js` | The arrow: anchor resolution, positioning, teardown |
| `src/rossum/index.js` | *(modify)* wire the feature in |
| `src/popup/components/App.jsx` | *(modify)* second unlock counter + Training section |
| `src/academy/index.jsx` | `initAcademy()` — auth wiring, progress subscription |
| `src/academy/store.js` | Academy signals |
| `src/academy/components/App.jsx` | Shell: mission list + detail + receipt |
| `src/academy/components/MissionList.jsx` | Mission map with rings and lock state |
| `src/academy/components/MissionDetail.jsx` | Steps, teaching markdown, per-step chips |
| `src/academy/components/ReceiptPanel.jsx` | Mint (with re-verification) + render the receipt |
| `src/academy/components/TrainerPanel.jsx` | Paste a receipt → valid/invalid |
| `src/academy/Academy.module.css` | All Academy styling |
| `src/console/store.js`, `boot.js`, `components/Rail.jsx`, `components/Console.jsx`, `index.jsx` | *(modify)* register the 6th app + its gate |
| `src/usage/event.js`, `PRIVACY.md` | *(modify)* five new event names |

---

### Task 1: Progress state, XP and linear unlock

**Files:**
- Create: `src/training/progress.js`
- Test: `tests/training-progress.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `emptyProgress(track, at)`, `markStep(progress, missionId, stepId, state, at)`, `startMission(progress, missionId, baseline, at)`, `stepState(progress, missionId, stepId)`, `isMissionComplete(track, progress, missionId)`, `missionStatus(track, progress, missionId)` → `'done'|'active'|'locked'`, `xpFor(track, progress)`, `levelFor(xp)`, `badges(track, progress)`, `isTrackComplete(track, progress)`, `migrate(track, progress)`. Step states are the strings `'passed' | 'self' | 'skipped'`.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-progress.test.js
import { describe, it, expect } from 'vitest';
import {
  emptyProgress, markStep, startMission, stepState, isMissionComplete,
  missionStatus, xpFor, levelFor, badges, isTrackComplete, migrate,
} from '../src/training/progress.js';

const TRACK = {
  id: 't', version: 1,
  missions: [
    { id: 'm1', steps: [{ id: 'm1.s1', kind: 'visit' }, { id: 'm1.s2', kind: 'self' }] },
    { id: 'm2', steps: [{ id: 'm2.s1', kind: 'api' }] },
  ],
};

describe('emptyProgress', () => {
  it('records the track identity and starts empty', () => {
    const p = emptyProgress(TRACK, 1000);
    expect(p.trackId).toBe('t');
    expect(p.trackVersion).toBe(1);
    expect(p.startedAt).toBe(1000);
    expect(p.missions).toEqual({});
  });
});

describe('markStep', () => {
  it('returns a new object and does not mutate the input', () => {
    const p = emptyProgress(TRACK, 1);
    const next = markStep(p, 'm1', 'm1.s1', 'passed', 2000);
    expect(stepState(next, 'm1', 'm1.s1')).toBe('passed');
    expect(stepState(p, 'm1', 'm1.s1')).toBe(null);
    expect(next).not.toBe(p);
  });

  it('is monotonic — a passed step is never downgraded', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'm1.s1', 'skipped', 3);
    expect(stepState(p, 'm1', 'm1.s1')).toBe('passed');
  });

  it('revokes a pass when explicitly reset to null (mint-time re-verification)', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'm1.s1', null, 3);
    expect(stepState(p, 'm1', 'm1.s1')).toBe(null);
  });
});

describe('startMission', () => {
  it('stores the baseline once and does not overwrite it on re-entry', () => {
    let p = startMission(emptyProgress(TRACK, 1), 'm1', { queueIds: [1] }, 10);
    p = startMission(p, 'm1', { queueIds: [1, 2] }, 20);
    expect(p.missions.m1.baseline).toEqual({ queueIds: [1] });
    expect(p.missions.m1.startedAt).toBe(10);
  });
});

describe('missionStatus (linear)', () => {
  it('opens the first mission, locks the rest, unlocks on completion', () => {
    const p0 = emptyProgress(TRACK, 1);
    expect(missionStatus(TRACK, p0, 'm1')).toBe('active');
    expect(missionStatus(TRACK, p0, 'm2')).toBe('locked');

    let p = markStep(p0, 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'm1.s2', 'self', 3);
    expect(isMissionComplete(TRACK, p, 'm1')).toBe(true);
    expect(missionStatus(TRACK, p, 'm1')).toBe('done');
    expect(missionStatus(TRACK, p, 'm2')).toBe('active');
  });
});

describe('xp and levels', () => {
  it('scores visit 10, api 25, self 10, plus 50 per completed mission', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    expect(xpFor(TRACK, p)).toBe(10);
    p = markStep(p, 'm1', 'm1.s2', 'self', 3);
    expect(xpFor(TRACK, p)).toBe(10 + 10 + 50);
  });

  it('scores a skipped step zero', () => {
    const p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'skipped', 2);
    expect(xpFor(TRACK, p)).toBe(0);
  });

  it('maps xp to a level', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(99)).toBe(1);
    expect(levelFor(100)).toBe(2);
    expect(levelFor(10_000)).toBe(5);
  });
});

describe('badges and completion', () => {
  it('awards one badge per completed mission and reports track completion', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'm1.s2', 'self', 3);
    expect(badges(TRACK, p)).toEqual(['m1']);
    expect(isTrackComplete(TRACK, p)).toBe(false);
    p = markStep(p, 'm2', 'm2.s1', 'passed', 4);
    expect(isTrackComplete(TRACK, p)).toBe(true);
  });
});

describe('migrate', () => {
  it('drops unknown step ids, keeps known ones, and stales an existing receipt', () => {
    let p = markStep(emptyProgress(TRACK, 1), 'm1', 'm1.s1', 'passed', 2);
    p = markStep(p, 'm1', 'GONE', 'passed', 3);
    p = { ...p, trackVersion: 0, receipt: { code: 'X' } };
    const m = migrate(TRACK, p);
    expect(stepState(m, 'm1', 'm1.s1')).toBe('passed');
    expect(stepState(m, 'm1', 'GONE')).toBe(null);
    expect(m.trackVersion).toBe(1);
    expect(m.receipt.stale).toBe(true);
  });

  it('is a no-op on a matching version', () => {
    const p = emptyProgress(TRACK, 1);
    expect(migrate(TRACK, p)).toEqual(p);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-progress.test.js`
Expected: FAIL — `Failed to resolve import "../src/training/progress.js"`.

- [ ] **Step 3: Write the implementation**

```js
// src/training/progress.js
// PURE. No chrome APIs, no DOM, no network. Owns the shape of a trainee's
// progress for ONE org, plus the reward math and the linear unlock rule.
// Step states: 'passed' (verified), 'self' (attested), 'skipped' (no credit).

export const STEP_XP = { visit: 10, api: 25, self: 10 };
export const MISSION_BONUS = 50;
// Level N spans LEVELS[N-1] .. LEVELS[N]. Data, not logic — tune freely.
export const LEVELS = [0, 100, 220, 350, 480];

export function emptyProgress(track, at) {
  return { trackId: track.id, trackVersion: track.version, startedAt: at, missions: {} };
}

function missionOf(track, missionId) {
  return track.missions.find((m) => m.id === missionId) || null;
}

export function stepState(progress, missionId, stepId) {
  return progress?.missions?.[missionId]?.steps?.[stepId]?.state ?? null;
}

export function startMission(progress, missionId, baseline, at) {
  const existing = progress.missions[missionId];
  if (existing) return progress; // baseline is captured exactly once
  return {
    ...progress,
    missions: { ...progress.missions, [missionId]: { startedAt: at, baseline, steps: {} } },
  };
}

export function markStep(progress, missionId, stepId, state, at) {
  const mission = progress.missions[missionId] || { startedAt: at, baseline: null, steps: {} };
  const prev = mission.steps[stepId]?.state ?? null;
  // Monotonic: only an explicit null (re-verification) may clear a pass.
  if (prev === 'passed' && state !== null) return progress;
  const steps = { ...mission.steps };
  if (state === null) delete steps[stepId];
  else steps[stepId] = { state, at };
  return { ...progress, missions: { ...progress.missions, [missionId]: { ...mission, steps } } };
}

export function isMissionComplete(track, progress, missionId) {
  const m = missionOf(track, missionId);
  if (!m) return false;
  return m.steps.every((s) => {
    const st = stepState(progress, missionId, s.id);
    return st === 'passed' || st === 'self';
  });
}

export function missionStatus(track, progress, missionId) {
  if (isMissionComplete(track, progress, missionId)) return 'done';
  const idx = track.missions.findIndex((m) => m.id === missionId);
  if (idx < 0) return 'locked';
  const allPriorDone = track.missions
    .slice(0, idx)
    .every((m) => isMissionComplete(track, progress, m.id));
  return allPriorDone ? 'active' : 'locked';
}

export function xpFor(track, progress) {
  let xp = 0;
  for (const m of track.missions) {
    for (const s of m.steps) {
      const st = stepState(progress, m.id, s.id);
      if (st === 'passed' || st === 'self') xp += STEP_XP[s.kind] ?? 0;
    }
    if (isMissionComplete(track, progress, m.id)) xp += MISSION_BONUS;
  }
  return xp;
}

export function levelFor(xp) {
  let level = 1;
  for (let i = 1; i < LEVELS.length; i++) if (xp >= LEVELS[i]) level = i + 1;
  return level;
}

export function badges(track, progress) {
  return track.missions.filter((m) => isMissionComplete(track, progress, m.id)).map((m) => m.id);
}

export function isTrackComplete(track, progress) {
  return track.missions.every((m) => isMissionComplete(track, progress, m.id));
}

// Reconcile stored progress against a newer shipped curriculum: keep step ids
// that still exist, drop the rest, and mark any receipt as issued against an
// older track rather than silently revalidating it.
export function migrate(track, progress) {
  if (!progress) return progress;
  if (progress.trackVersion === track.version && progress.trackId === track.id) return progress;
  const missions = {};
  for (const m of track.missions) {
    const stored = progress.missions?.[m.id];
    if (!stored) continue;
    const known = {};
    for (const s of m.steps) if (stored.steps?.[s.id]) known[s.id] = stored.steps[s.id];
    missions[m.id] = { ...stored, steps: known };
  }
  const next = { ...progress, trackId: track.id, trackVersion: track.version, missions };
  if (next.receipt) next.receipt = { ...next.receipt, stale: true };
  return next;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/training-progress.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/training/progress.js tests/training-progress.test.js
```

---

### Task 2: Baseline signatures and delta predicates

**Files:**
- Create: `src/training/baseline.js`
- Test: `tests/training-baseline.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `queueIds(data)`, `hookQueuePairs(data)`, `fieldCount(schema)`, `ruleIds(data)`, `thresholds(data)`, `collectionCount(data)`, `grew(before, after)`, `changed(before, after)`, `isIdsOnly(sig)`. All signature builders take a parsed API response and return integers or `"<int>:<int>"` strings.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-baseline.test.js
import { describe, it, expect } from 'vitest';
import {
  queueIds, hookQueuePairs, fieldCount, ruleIds, thresholds, collectionCount,
  grew, changed, isIdsOnly,
} from '../src/training/baseline.js';

const HOOKS = { results: [
  { url: 'https://o.rossum.app/api/v1/hooks/7', queues: ['https://o.rossum.app/api/v1/queues/1'] },
  { url: 'https://o.rossum.app/api/v1/hooks/8', queues: [] },
] };

describe('signature builders', () => {
  it('extracts numeric queue ids from urls, sorted', () => {
    const data = { results: [
      { url: 'https://o.rossum.app/api/v1/queues/12' },
      { url: 'https://o.rossum.app/api/v1/queues/3' },
    ] };
    expect(queueIds(data)).toEqual([3, 12]);
  });

  it('builds hook:queue pairs of numeric ids', () => {
    expect(hookQueuePairs(HOOKS)).toEqual(['7:1']);
  });

  it('counts schema fields across sections without recording their ids', () => {
    const schema = { content: [
      { category: 'section', children: [{ id: 'invoice_id' }, { id: 'total' }] },
      { category: 'section', children: [{ id: 'vendor' }] },
    ] };
    expect(fieldCount(schema)).toBe(3);
  });

  // Real nesting, verified live on elis 2026-08-07: a multivalue's `children`
  // is a single OBJECT (the tuple), whose `children` is the column array.
  const TABLE_SCHEMA = (columns) => ({ content: [
    { category: 'section', id: 'sec', children: [
      { category: 'datapoint', id: 'total' },
      { category: 'multivalue', id: 'line_items', children: {
        category: 'tuple', id: 'line_item', children: columns,
      } },
    ] },
  ] });

  it('counts fields nested inside a line-item table', () => {
    const schema = TABLE_SCHEMA([
      { category: 'datapoint', id: 'item_code' },
      { category: 'datapoint', id: 'item_qty' },
    ]);
    // 1 datapoint + multivalue + tuple + 2 columns = 5. The section is a
    // container, not a field.
    expect(fieldCount(schema)).toBe(5);
  });

  it('moves when a column is added inside a table — the delta the step relies on', () => {
    const before = fieldCount(TABLE_SCHEMA([{ category: 'datapoint', id: 'item_code' }]));
    const after = fieldCount(TABLE_SCHEMA([
      { category: 'datapoint', id: 'item_code' },
      { category: 'datapoint', id: 'item_qty' },
    ]));
    expect(grew(before, after)).toBe(true);
  });

  it('extracts rule ids and per-queue thresholds', () => {
    expect(ruleIds({ results: [{ id: 5 }, { id: 2 }] })).toEqual([2, 5]);
    expect(thresholds({ results: [
      { url: 'https://o.rossum.app/api/v1/queues/4', default_score_threshold: 0.8 },
    ] })).toEqual({ 4: 0.8 });
  });

  it('counts Data Storage collections from the REAL `result` key', () => {
    // The shape the live endpoint actually returns (singular `result`).
    // Getting this key wrong returns 0 forever and silently kills the step.
    expect(collectionCount({ result: ['vendors', 'gl_codes'] })).toBe(2);
    expect(collectionCount({ result: [] })).toBe(0);
  });

  it('tolerates the defensive fallback shapes', () => {
    expect(collectionCount({ collections: ['a'] })).toBe(1);
    expect(collectionCount({ results: [{}, {}, {}] })).toBe(3);
    expect(collectionCount({})).toBe(0);
  });
});

describe('delta predicates', () => {
  it('grew() is true only when a NEW member appears', () => {
    expect(grew([1, 2], [1, 2, 3])).toBe(true);
    expect(grew([1, 2], [1, 2])).toBe(false);
    expect(grew([1, 2], [1])).toBe(false);
    expect(grew(2, 3)).toBe(true);      // counts
    expect(grew(2, 2)).toBe(false);
  });

  it('changed() is true when any shared key changes value', () => {
    expect(changed({ 4: 0.8 }, { 4: 0.9 })).toBe(true);
    expect(changed({ 4: 0.8 }, { 4: 0.8 })).toBe(false);
    expect(changed({ 4: 0.8 }, { 4: 0.8, 5: 0.7 })).toBe(false); // a new queue is not a change
  });

  it('treats a missing baseline as "cannot have grown"', () => {
    expect(grew(null, [1])).toBe(false);
    expect(changed(null, { 4: 0.9 })).toBe(false);
  });
});

describe('isIdsOnly — the privacy guard', () => {
  it('accepts integers, id pairs and maps of them', () => {
    expect(isIdsOnly([1, 2, 3])).toBe(true);
    expect(isIdsOnly(['7:1'])).toBe(true);
    expect(isIdsOnly({ 4: 0.8 })).toBe(true);
    expect(isIdsOnly(7)).toBe(true);
  });

  it('rejects any org-authored string', () => {
    expect(isIdsOnly(['vendors'])).toBe(false);
    expect(isIdsOnly({ name: 'Acme queue' })).toBe(false);
    expect(isIdsOnly(['invoice_id'])).toBe(false);
  });

  it('rejects every builder output that is not ids-only', () => {
    for (const sig of [queueIds({ results: [] }), hookQueuePairs(HOOKS), fieldCount({ content: [] }),
      ruleIds({ results: [] }), thresholds({ results: [] }), collectionCount({ collections: [] })]) {
      expect(isIdsOnly(sig)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-baseline.test.js`
Expected: FAIL — cannot resolve `../src/training/baseline.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/training/baseline.js
// PURE. Turns an API response into a compact signature used for MISSION-START
// baselines and delta checks. Signatures may contain ONLY integers or
// "<int>:<int>" id pairs — never a name, a schema-field id or a collection
// name. A step must be verifiable without recording anything about the org's
// contents (see the spec, §5.2).

const idFromUrl = (url) => {
  const m = /\/(\d+)\/?$/.exec(String(url || ''));
  return m ? Number(m[1]) : null;
};

const numsSorted = (list) => list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

export function queueIds(data) {
  return numsSorted((data?.results || []).map((q) => idFromUrl(q.url)));
}

export function hookQueuePairs(data) {
  const out = [];
  for (const hook of data?.results || []) {
    const hookId = idFromUrl(hook.url);
    if (hookId == null) continue;
    for (const q of hook.queues || []) {
      const queueId = idFromUrl(q);
      if (queueId != null) out.push(`${hookId}:${queueId}`);
    }
  }
  return out.sort();
}

// Counts every field-like node at ANY depth. VERIFIED LIVE on elis 2026-08-07:
// a line-item table nests as multivalue → `children` (a single OBJECT, not an
// array) → tuple → `children` (the array of column datapoints). Counting only
// `content[].children` would score a whole table as ONE field, so a trainee who
// added a table column would move the count by zero and the step would never
// tick, with no explanation. Sections are containers, not fields, so they are
// excluded; multivalue/tuple wrappers are counted, which is harmless because
// the check only cares that the number MOVED.
export function fieldCount(schema) {
  let n = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.id != null && node.category !== 'section') n += 1;
    if (node.children) walk(node.children); // array OR single object
  };
  walk(schema?.content);
  return n;
}

export function ruleIds(data) {
  return numsSorted((data?.results || []).map((r) => Number(r.id)));
}

export function thresholds(data) {
  const out = {};
  for (const q of data?.results || []) {
    const id = idFromUrl(q.url);
    if (id != null && typeof q.default_score_threshold === 'number') {
      out[id] = q.default_score_threshold;
    }
  }
  return out;
}

// The live contract for POST /collections/list is `{ result: [...] }` —
// SINGULAR. Verified against the shipping client: src/mdh/components/Sidebar.jsx
// reads `res.result`, and every test mock of that endpoint uses the same shape.
// `collections`/`results` are kept only as defensive fallbacks; reading the
// wrong key here returns 0 forever, which silently makes the step that depends
// on it impossible to complete.
export function collectionCount(data) {
  if (Array.isArray(data?.result)) return data.result.length;
  if (Array.isArray(data?.collections)) return data.collections.length;
  if (Array.isArray(data?.results)) return data.results.length;
  return 0;
}

// A NEW member (or a higher count) appeared. A missing baseline means the
// mission never started, so nothing can have grown.
export function grew(before, after) {
  if (before == null) return false;
  if (typeof before === 'number') return typeof after === 'number' && after > before;
  const seen = new Set(before);
  return (after || []).some((x) => !seen.has(x));
}

// A value the baseline already knew about now differs. New keys are not changes.
export function changed(before, after) {
  if (before == null) return false;
  return Object.keys(before).some((k) => after && k in after && after[k] !== before[k]);
}

const ID_PAIR = /^\d+:\d+$/;

export function isIdsOnly(sig) {
  if (sig == null) return true;
  if (typeof sig === 'number') return true;
  if (typeof sig === 'string') return ID_PAIR.test(sig);
  if (Array.isArray(sig)) return sig.every(isIdsOnly);
  if (typeof sig === 'object') {
    return Object.entries(sig).every(([k, v]) => /^\d+$/.test(k) && isIdsOnly(v));
  }
  return false;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/training-baseline.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/training/baseline.js tests/training-baseline.test.js
```

---

### Task 3: Step evaluation

**Files:**
- Create: `src/training/steps.js`
- Test: `tests/training-steps.test.js`

**Interfaces:**
- Consumes: `src/devtools/detect.js` `detectResource`; `src/training/baseline.js`.
- Produces: `CHECKS` (map of `{ id, paths, signature, pass }`), `evaluateVisit(step, location)`, `evaluateApi(check, sigNow, baseline)`, `signatureFor(checkId, responses)`, `checkIds()`.

Every `api` step names a `CHECKS` entry. A check declares the API paths it needs so a caller can fetch them without knowing the check's internals.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-steps.test.js
import { describe, it, expect } from 'vitest';
import { CHECKS, evaluateVisit, evaluateApi, signatureFor, checkIds } from '../src/training/steps.js';

const loc = (pathname, search = '') => ({ pathname, search });

describe('evaluateVisit', () => {
  it('matches a detail route by type', () => {
    expect(evaluateVisit({ target: { type: 'queue', detail: true } }, loc('/queues/42'))).toBe(true);
    expect(evaluateVisit({ target: { type: 'hook', detail: true } }, loc('/queues/42'))).toBe(false);
  });

  it('distinguishes a list route from a detail route of the same type', () => {
    const list = loc('/extensions/my-extensions');
    const detail = loc('/extensions/my-extensions/9');
    expect(evaluateVisit({ target: { type: 'hook', detail: false } }, list)).toBe(true);
    expect(evaluateVisit({ target: { type: 'hook', detail: false } }, detail)).toBe(false);
    expect(evaluateVisit({ target: { type: 'hook', detail: true } }, detail)).toBe(true);
  });

  it('matches the organization dashboard', () => {
    const l = loc('/documents', '?level=all');
    expect(evaluateVisit({ target: { type: 'organization' } }, l)).toBe(true);
  });

  it('returns false when no resource is detected', () => {
    expect(evaluateVisit({ target: { type: 'queue', detail: true } }, loc('/nowhere'))).toBe(false);
  });
});

describe('CHECKS', () => {
  it('every check declares an id, paths and both functions', () => {
    for (const id of checkIds()) {
      const c = CHECKS[id];
      expect(c.id).toBe(id);
      expect(Array.isArray(c.paths)).toBe(true);
      expect(c.paths.length).toBeGreaterThan(0);
      expect(typeof c.signature).toBe('function');
      expect(typeof c.pass).toBe('function');
    }
  });

  it('hookAttachedToQueue passes only when a new hook:queue pair appears', () => {
    const before = { '/api/v1/hooks?page_size=100': { results: [
      { url: '/api/v1/hooks/7', queues: [] }] } };
    const after = { '/api/v1/hooks?page_size=100': { results: [
      { url: '/api/v1/hooks/7', queues: ['/api/v1/queues/1'] }] } };
    const base = signatureFor('hookAttachedToQueue', before);
    expect(evaluateApi(CHECKS.hookAttachedToQueue, signatureFor('hookAttachedToQueue', before), base)).toBe(false);
    expect(evaluateApi(CHECKS.hookAttachedToQueue, signatureFor('hookAttachedToQueue', after), base)).toBe(true);
  });

  it('thresholdChanged passes only when a known queue threshold moves', () => {
    const p = CHECKS.thresholdChanged.paths[0];
    const base = signatureFor('thresholdChanged', { [p]: { results: [
      { url: '/api/v1/queues/4', default_score_threshold: 0.8 }] } });
    const same = signatureFor('thresholdChanged', { [p]: { results: [
      { url: '/api/v1/queues/4', default_score_threshold: 0.8 }] } });
    const moved = signatureFor('thresholdChanged', { [p]: { results: [
      { url: '/api/v1/queues/4', default_score_threshold: 0.95 }] } });
    expect(evaluateApi(CHECKS.thresholdChanged, same, base)).toBe(false);
    expect(evaluateApi(CHECKS.thresholdChanged, moved, base)).toBe(true);
  });

  it('never passes when the baseline is missing', () => {
    const p = CHECKS.ruleCreated.paths[0];
    const now = signatureFor('ruleCreated', { [p]: { results: [{ id: 1 }] } });
    expect(evaluateApi(CHECKS.ruleCreated, now, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-steps.test.js`
Expected: FAIL — cannot resolve `../src/training/steps.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/training/steps.js
// PURE. Evaluation only — the curriculum lives in track.js, so a syllabus
// rewrite never touches this file and these rules are testable without it.
import { detectResource } from '../devtools/detect.js';
import {
  queueIds, hookQueuePairs, fieldCount, ruleIds, thresholds, collectionCount,
  grew, changed,
} from './baseline.js';

// A `visit` step names a resource TYPE from the live-verified route table in
// src/devtools/detect.js. `detail: true` requires a detail route (the
// descriptor carries an id); `detail: false` requires a list route.
export function evaluateVisit(step, location) {
  const found = detectResource(location);
  if (!found) return false;
  const want = step.target || {};
  if (found.type !== want.type) return false;
  if (want.detail === true) return found.id != null;
  if (want.detail === false) return found.id == null;
  return true;
}

const HOOKS = '/api/v1/hooks?page_size=100';
const QUEUES = '/api/v1/queues?page_size=100';
const RULES = '/api/v1/rules?page_size=100';
const SCHEMAS = '/api/v1/schemas?page_size=100';
// Data Storage. VERIFIED LIVE 2026-08-07 against the shipping client
// (src/mdh/api.js builds `${serviceBase}/api/v1${path}`): the endpoint is a
// POST, authenticated with `Bearer` — NOT the `Token` scheme /api/v1/ uses —
// and it answers 401 (not 404) unauthenticated, which is what an existing
// auth-gated route looks like. It differs from every other check on three axes
// (method, auth scheme, path prefix), which is why it needs its own helper.
const COLLECTIONS = '/svc/data-storage/api/v1/collections/list';
const COLLECTIONS_BODY = { filter: null, nameOnly: true };

export const CHECKS = {
  hookAttachedToQueue: {
    id: 'hookAttachedToQueue',
    paths: [HOOKS],
    signature: (r) => hookQueuePairs(r[HOOKS]),
    pass: grew,
  },
  schemaFieldAdded: {
    id: 'schemaFieldAdded',
    // Org-wide field count across every schema. Counting all schemas avoids
    // having to resolve "the queue the trainee happens to be on" at check time,
    // and a delta still means the trainee added a field somewhere. Names are
    // never recorded — only how many fields exist.
    paths: [SCHEMAS],
    signature: (r) => (r[SCHEMAS]?.results || []).reduce((n, s) => n + fieldCount(s), 0),
    pass: grew,
  },
  ruleCreated: {
    id: 'ruleCreated',
    paths: [RULES],
    signature: (r) => ruleIds(r[RULES]),
    pass: grew,
  },
  thresholdChanged: {
    id: 'thresholdChanged',
    paths: [QUEUES],
    signature: (r) => thresholds(r[QUEUES]),
    pass: changed,
  },
  collectionAdded: {
    id: 'collectionAdded',
    paths: [COLLECTIONS],
    // The only check that is not a plain GET on /api/v1/. These three optional
    // fields keep the `paths` contract uniform: every caller does
    // `get(path, { method, body, auth })` and the defaults ('GET', undefined,
    // 'token') reproduce every other check exactly.
    method: 'POST',
    body: COLLECTIONS_BODY,
    auth: 'bearer',
    signature: (r) => collectionCount(r[COLLECTIONS]),
    pass: grew,
  },
  queueCreated: {
    id: 'queueCreated',
    paths: [QUEUES],
    signature: (r) => queueIds(r[QUEUES]),
    pass: grew,
  },
};

export const checkIds = () => Object.keys(CHECKS);

export function signatureFor(checkId, responses) {
  return CHECKS[checkId].signature(responses);
}

export function evaluateApi(check, sigNow, baseline) {
  if (baseline == null) return false;
  return check.pass(baseline, sigNow);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/training-steps.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/training/steps.js tests/training-steps.test.js
```

---

### Task 4: Curriculum data and its integrity test

**Files:**
- Create: `src/training/track.js`
- Test: `tests/training-track.test.js`

**Interfaces:**
- Consumes: `checkIds()` from `steps.js`.
- Produces: `TRACK` — `{ id, version, title, missions: [{ id, title, blurb, steps: [{ id, kind, target?, check?, anchor?, hint, teach }] }] }`.

> The syllabus below is the spec's §8 strawman. The owner is expected to rewrite the wording; the integrity test is what keeps a rewrite honest.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-track.test.js
import { describe, it, expect } from 'vitest';
import { TRACK } from '../src/training/track.js';
import { checkIds } from '../src/training/steps.js';
import { detectResource, ROUTES } from '../src/devtools/detect.js';

const steps = TRACK.missions.flatMap((m) => m.steps);

describe('curriculum integrity', () => {
  it('has a stable id and an integer version', () => {
    expect(TRACK.id).toBe('partner-foundations');
    expect(Number.isInteger(TRACK.version)).toBe(true);
  });

  it('gives every mission and step a unique id', () => {
    const missionIds = TRACK.missions.map((m) => m.id);
    expect(new Set(missionIds).size).toBe(missionIds.length);
    const stepIds = steps.map((s) => s.id);
    expect(new Set(stepIds).size).toBe(stepIds.length);
  });

  it('prefixes every step id with its mission id', () => {
    for (const m of TRACK.missions) {
      for (const s of m.steps) expect(s.id.startsWith(`${m.id}.`)).toBe(true);
    }
  });

  it('uses only known step kinds', () => {
    for (const s of steps) expect(['visit', 'api', 'self']).toContain(s.kind);
  });

  it('points every api step at a check that exists', () => {
    for (const s of steps.filter((x) => x.kind === 'api')) {
      expect(checkIds()).toContain(s.check);
    }
  });

  it('points every visit step at a type detectResource can actually return', () => {
    const known = new Set([...ROUTES.map((r) => r.type), 'organization', 'label', 'inbox', 'schema']);
    for (const s of steps.filter((x) => x.kind === 'visit')) {
      expect(known).toContain(s.target.type);
    }
  });

  it('gives every step a one-line plain hint and markdown teaching text', () => {
    for (const s of steps) {
      expect(typeof s.hint).toBe('string');
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.hint).not.toContain('\n');   // the card renders one line
      expect(s.hint).not.toContain('<');    // textContent only, never markup
      expect(typeof s.teach).toBe('string');
      expect(s.teach.length).toBeGreaterThan(0);
    }
  });

  it('anchors by href only — never by CSS class or id selector', () => {
    for (const s of steps.filter((x) => x.anchor)) {
      expect(Object.keys(s.anchor)).toEqual(['hrefIncludes']);
      expect(typeof s.anchor.hrefIncludes).toBe('string');
    }
  });

  it('detects the documented dashboard route the first step relies on', () => {
    expect(detectResource({ pathname: '/documents', search: '?level=all' }).type).toBe('organization');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-track.test.js`
Expected: FAIL — cannot resolve `../src/training/track.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/training/track.js
// DATA ONLY — no logic lives here, and no data lives in steps.js. Editing the
// syllabus must never require touching evaluation.
//
// step.kind:
//   'visit' → target: { type, detail? } matched via detectResource()
//   'api'   → check: a CHECKS id in steps.js, passing on a delta vs the
//             mission-start baseline
//   'self'  → the trainee attests; printed on the receipt as self-attested
// step.hint   → ONE plain-text line, rendered with textContent in the card
// step.teach  → markdown, rendered in the Academy
// step.anchor → { hrefIncludes } only. Hrefs are a verified contract; CSS
//               classes are not. No anchor ⇒ no arrow, never a blocked step.

export const TRACK = {
  id: 'partner-foundations',
  version: 1,
  title: 'Partner foundations',
  missions: [
    {
      id: 'm1',
      title: 'Orientation',
      blurb: 'Find your way around: where documents live, and what a queue and an annotation are.',
      steps: [
        { id: 'm1.s1', kind: 'visit', target: { type: 'organization' },
          anchor: { hrefIncludes: '/documents' },
          hint: 'Open the all-documents dashboard.',
          teach: 'The dashboard is every document in the organization, across all queues. Start here when you have no idea where a document ended up.' },
        { id: 'm1.s2', kind: 'visit', target: { type: 'queue', detail: true },
          anchor: { hrefIncludes: '/queues/' },
          hint: 'Open any queue.',
          teach: 'A **queue** is where documents land and where almost all configuration hangs: the schema, the extensions that run, the automation settings.' },
        { id: 'm1.s3', kind: 'visit', target: { type: 'annotation', detail: true },
          hint: 'Open any document from that queue.',
          teach: 'The document you opened is an **annotation** — the extracted data plus its position on the page. The id in the URL is the annotation id, not the document id.' },
        { id: 'm1.s4', kind: 'self',
          hint: "Find a field's schema_id using the extension's overlay.",
          teach: 'Turn on **Schema ID overlays** in this extension\'s popup, then look at a field on the annotation screen. Every field has a `schema_id` — the name you use everywhere in configuration.' },
      ],
    },
    {
      id: 'm2',
      title: 'Queues & schema',
      blurb: 'The schema is the contract between the document and everything downstream.',
      steps: [
        // detail:false is load-bearing — the queue Fields tab resolves to a
        // schema descriptor with NO id, while Field Manager's detail route
        // carries one. Without it this step would also tick on m2.s3's page.
        { id: 'm2.s1', kind: 'visit', target: { type: 'schema', detail: false },
          hint: "Open a queue's Fields tab.",
          teach: 'The **Fields** tab edits that queue\'s schema: sections, fields, and their `schema_id`s.' },
        { id: 'm2.s2', kind: 'api', check: 'schemaFieldAdded',
          hint: 'Add a field to that schema.',
          teach: 'Add any field. We confirm it by reading the schema and comparing the field **count** against a snapshot taken when this mission started — so a schema that already had the field does not count.' },
        { id: 'm2.s3', kind: 'visit', target: { type: 'schema', detail: true },
          hint: 'Open the same field in Field Manager.',
          teach: 'Field Manager is the org-wide view of fields, as opposed to the per-queue Fields tab.' },
        { id: 'm2.s4', kind: 'self',
          hint: 'Find a formula field and read its formula.',
          teach: 'A **formula field** computes its value from other fields. Formulas are the first tool to reach for before writing an extension.' },
      ],
    },
    {
      id: 'm3',
      title: 'Extensions',
      blurb: 'Extensions are how an implementation gets its behaviour.',
      steps: [
        { id: 'm3.s1', kind: 'visit', target: { type: 'hook', detail: false },
          anchor: { hrefIncludes: '/extensions/my-extensions' },
          hint: 'Open the Extensions list.',
          teach: 'Every extension in the organization, whether it is a serverless function or a webhook.' },
        { id: 'm3.s2', kind: 'visit', target: { type: 'hook', detail: true },
          hint: 'Open any extension and read its trigger events.',
          teach: 'The **events** decide when the extension runs — on upload, on validation, on export. Getting the event wrong is the most common reason an extension "does nothing".' },
        { id: 'm3.s3', kind: 'api', check: 'hookAttachedToQueue',
          hint: 'Attach an extension to a queue.',
          teach: 'An extension only runs on the queues it is attached to. We confirm a **new** extension-to-queue link appeared since this mission started.' },
        { id: 'm3.s4', kind: 'self',
          hint: 'Find that extension\'s execution log.',
          teach: 'The log shows each run and its output. Log access depends on your role, so this step is yours to confirm.' },
        { id: 'm3.s5', kind: 'visit', target: { type: 'queue', detail: true },
          hint: 'Go back to the queue you attached it to.',
          teach: 'Close the loop: the queue is where you verify the extension is listed.' },
      ],
    },
    {
      id: 'm4',
      title: 'Automation & rules',
      blurb: 'What makes a document skip human review — and what stops it.',
      steps: [
        { id: 'm4.s1', kind: 'visit', target: { type: 'engine', detail: true },
          hint: 'Open an AI engine.',
          teach: 'The **engine** does the extraction. A queue is bound to either a generic or a dedicated engine.' },
        { id: 'm4.s2', kind: 'api', check: 'ruleCreated',
          hint: 'Create a rule.',
          teach: 'A **rule** fires on a condition and takes actions — raising a message, blocking automation. We confirm a rule id exists that did not when this mission started.' },
        { id: 'm4.s3', kind: 'api', check: 'thresholdChanged',
          hint: "Change a queue's score threshold.",
          teach: 'The **score threshold** decides how confident extraction must be before a field passes without review. We confirm the value moved on a queue that already existed.' },
        { id: 'm4.s4', kind: 'self',
          hint: 'Confirm a document.',
          teach: 'Confirming pushes the annotation to the next stage. Whether you can depends on your role and on there being a document to confirm.' },
      ],
    },
    {
      id: 'm5',
      title: 'Master data',
      blurb: 'Matching extracted values against the customer\'s own data.',
      steps: [
        { id: 'm5.s1', kind: 'self',
          hint: "Open Dataset Management from this extension's popup.",
          teach: 'Dataset Management browses **Data Storage** collections — the master data an implementation matches against.' },
        { id: 'm5.s2', kind: 'api', check: 'collectionAdded',
          hint: 'Create a collection.',
          teach: 'We confirm the collection **count** grew. Collection names are never recorded — only how many there are.' },
        { id: 'm5.s3', kind: 'self',
          hint: 'Run a query against your collection.',
          teach: 'Queries are MongoDB aggregation pipelines. This is exactly how a matching extension looks data up at runtime.' },
      ],
    },
  ],
};
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/training-track.test.js`
Expected: PASS, 9 tests. If the `visit` type assertion fails, the route is not in `detect.js` — do **not** add it from memory; it belongs to Task 7.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/training/track.js tests/training-track.test.js
```

---

### Task 5: Receipt, code formatting and HMAC

**Files:**
- Create: `src/training/receipt.js`, `src/training/hmac.js`, `src/training/receiptKey.js`
- Test: `tests/training-receipt.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `canonicalString(fields)`, `formatCode(bytes)`, `renderReceipt(fields, code)`, `parseReceipt(text)`, `mintCode(fields, sign)`, `verifyReceipt(text, sign)`; `hmacSha256(key, message)` → `Uint8Array`; `RECEIPT_KEY`. `fields` = `{ trackId, trackVersion, host, userId, username, missionsPassed: string[], selfCount: number, dateUtc: 'YYYY-MM-DD' }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-receipt.test.js
import { describe, it, expect } from 'vitest';
import {
  canonicalString, formatCode, renderReceipt, parseReceipt, mintCode, verifyReceipt,
} from '../src/training/receipt.js';
import { hmacSha256 } from '../src/training/hmac.js';

const FIELDS = {
  trackId: 'partner-foundations', trackVersion: 1,
  host: 'partner-sandbox.rossum.app', userId: 42, username: 'j.doe',
  missionsPassed: ['m1', 'm2', 'm3', 'm4', 'm5'], selfCount: 6, dateUtc: '2026-08-07',
};

// Deterministic stand-in for HMAC so receipt.js stays pure and testable.
// It MUST avalanche — fold the whole message into one accumulator, then expand
// that into 32 bytes — so a one-character edit changes every byte, the way a
// real MAC does. A positional stand-in (`out[i % 32] += charCodeAt(i)`) leaves
// most bytes untouched by a single-character edit, which would make the tamper
// tests below pass or fail on where in the string the edit happened to land.
const fakeSign = async (msg) => {
  const out = new Uint8Array(32);
  let h = 0x811c9dc5;
  for (let i = 0; i < msg.length; i++) h = Math.imul(h ^ msg.charCodeAt(i), 0x01000193) >>> 0;
  for (let b = 0; b < 32; b++) { h = Math.imul(h ^ (b + 1), 0x01000193) >>> 0; out[b] = h & 0xff; }
  return out;
};

describe('canonicalString', () => {
  it('is stable, ordered and pipe-delimited', () => {
    expect(canonicalString(FIELDS)).toBe(
      'RSAT1|partner-foundations@1|partner-sandbox.rossum.app|42|m1,m2,m3,m4,m5|6|2026-08-07');
  });

  it('excludes the username — it is printed, not signed', () => {
    expect(canonicalString(FIELDS)).not.toContain('j.doe');
  });

  it('changes when any signed field changes', () => {
    const base = canonicalString(FIELDS);
    expect(canonicalString({ ...FIELDS, userId: 43 })).not.toBe(base);
    expect(canonicalString({ ...FIELDS, host: 'other.rossum.app' })).not.toBe(base);
    expect(canonicalString({ ...FIELDS, trackVersion: 2 })).not.toBe(base);
  });
});

describe('formatCode', () => {
  it('emits RSA1- plus three Crockford base32 groups of four', () => {
    const code = formatCode(new Uint8Array(32).fill(0xff));
    expect(code).toMatch(/^RSA1-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('never emits I, L, O or U', () => {
    for (let b = 0; b < 256; b += 7) {
      expect(formatCode(new Uint8Array(32).fill(b))).not.toMatch(/[ILOU]/);
    }
  });

  it('is deterministic', () => {
    const bytes = new Uint8Array(32).fill(9);
    expect(formatCode(bytes)).toBe(formatCode(bytes));
  });
});

describe('render and parse round-trip', () => {
  it('parses back exactly what was rendered', async () => {
    const code = await mintCode(FIELDS, fakeSign);
    const parsed = parseReceipt(renderReceipt(FIELDS, code));
    expect(parsed.fields).toEqual(FIELDS);
    expect(parsed.code).toBe(code);
  });

  it('prints the self-attested count so it cannot be read as verified', () => {
    const text = renderReceipt(FIELDS, 'RSA1-AAAA-BBBB-CCCC');
    expect(text).toContain('self-attested');
    expect(text).toContain('6');
  });

  it('returns null on a malformed receipt', () => {
    expect(parseReceipt('nonsense')).toBe(null);
    expect(parseReceipt('')).toBe(null);
  });

  it('tolerates leading and trailing whitespace only', async () => {
    const code = await mintCode(FIELDS, fakeSign);
    expect(parseReceipt(`\n  ${renderReceipt(FIELDS, code)}  \n`).code).toBe(code);
  });
});

describe('verifyReceipt', () => {
  it('accepts an untampered receipt', async () => {
    const text = renderReceipt(FIELDS, await mintCode(FIELDS, fakeSign));
    expect(await verifyReceipt(text, fakeSign)).toEqual({ valid: true, fields: FIELDS });
  });

  it('rejects a receipt whose org was edited', async () => {
    const text = renderReceipt(FIELDS, await mintCode(FIELDS, fakeSign))
      .replace('partner-sandbox.rossum.app', 'someone-else.rossum.app');
    expect((await verifyReceipt(text, fakeSign)).valid).toBe(false);
  });

  it('rejects a receipt whose user was edited', async () => {
    // Must match what renderReceipt actually emits: `user | j.doe (id 42)`.
    const text = renderReceipt(FIELDS, await mintCode(FIELDS, fakeSign)).replace('(id 42)', '(id 43)');
    expect(text).toContain('(id 43)'); // guard: a no-op replace would vacuously pass
    expect((await verifyReceipt(text, fakeSign)).valid).toBe(false);
  });

  it('rejects unparseable input without throwing', async () => {
    expect(await verifyReceipt('garbage', fakeSign)).toEqual({ valid: false, fields: null });
  });
});

describe('hmacSha256', () => {
  it('produces 32 deterministic bytes', async () => {
    const a = await hmacSha256('k', 'message');
    const b = await hmacSha256('k', 'message');
    const c = await hmacSha256('k', 'message2');
    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-receipt.test.js`
Expected: FAIL — cannot resolve `../src/training/receipt.js`.

- [ ] **Step 3: Generate the signing key**

Run: `openssl rand -base64 32`

Paste the output as the literal below. Do not reuse the example value; it is a placeholder, not a secret.

```js
// src/training/receiptKey.js
// The receipt signing key. Isolated in its own module so exactly one file names
// it — tests/training-key-boundary.test.js enforces that, and also enforces
// that it only ever reaches dist/console/console.js (the Academy mints and
// validates; no other surface needs it).
//
// Extractable from the bundle BY DESIGN, exactly like src/usage/ga4Config.js.
// It deters copying a code between trainees; it is not proof against a
// determined forger. Rotating it invalidates every previously issued receipt
// and costs a full Chrome review, so rotate only on a real leak.
export const RECEIPT_KEY = 'REPLACE_WITH_openssl_rand_base64_32_OUTPUT';
```

- [ ] **Step 4: Write the implementation**

```js
// src/training/hmac.js
// The only module that touches crypto.subtle. Verified available in this
// context (extension pages and https content scripts are secure contexts).
export async function hmacSha256(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return new Uint8Array(sig);
}
```

```js
// src/training/receipt.js
// PURE. The signing function is injected, so this module has no crypto
// dependency and both minting and validation are unit-testable. Mint and check
// share it, so they cannot disagree.

// Crockford base32: no I, L, O or U — the four characters people mistype.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 12; // 3 groups of 4 → 60 bits

export function canonicalString(f) {
  return [
    'RSAT1',
    `${f.trackId}@${f.trackVersion}`,
    f.host,
    String(f.userId),
    f.missionsPassed.join(','),
    String(f.selfCount),
    f.dateUtc,
  ].join('|');
}

export function formatCode(bytes) {
  let out = '';
  for (let i = 0; i < CODE_CHARS; i++) out += ALPHABET[bytes[i] % 32];
  return `RSA1-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export async function mintCode(fields, sign) {
  return formatCode(await sign(canonicalString(fields)));
}

export function renderReceipt(f, code) {
  return [
    'ROSSUM PARTNER ONBOARDING — COMPLETION RECEIPT',
    `track          | ${f.trackId}@${f.trackVersion}`,
    `org            | ${f.host}`,
    `user           | ${f.username} (id ${f.userId})`,
    `missions       | ${f.missionsPassed.join(',')}`,
    `self-attested  | ${f.selfCount}`,
    `issued         | ${f.dateUtc}`,
    `code           | ${code}`,
  ].join('\n');
}

// `[ \t]*`, never `\s*`: \s matches a newline, so an empty field value would let
// the match cross into the next line and capture ITS content as this field's
// value — a malformed paste must fail to parse, never mis-parse.
const LINE = (label) => new RegExp(`^${label}[ \\t]*\\|[ \\t]*(.+)$`, 'm');

export function parseReceipt(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('ROSSUM PARTNER ONBOARDING')) return null;
  const grab = (label) => {
    const m = LINE(label).exec(t);
    return m ? m[1].trim() : null;
  };
  const track = grab('track');
  const user = grab('user');
  const code = grab('code');
  if (!track || !user || !code) return null;
  const trackM = /^(.+)@(\d+)$/.exec(track);
  const userM = /^(.*)\s+\(id\s+(\d+)\)$/.exec(user);
  const missions = grab('missions');
  const self = grab('self-attested');
  const issued = grab('issued');
  const host = grab('org');
  if (!trackM || !userM || missions == null || self == null || !issued || !host) return null;
  return {
    fields: {
      trackId: trackM[1], trackVersion: Number(trackM[2]),
      host, userId: Number(userM[2]), username: userM[1],
      missionsPassed: missions.split(',').filter(Boolean),
      selfCount: Number(self), dateUtc: issued,
    },
    code,
  };
}

export async function verifyReceipt(text, sign) {
  const parsed = parseReceipt(text);
  if (!parsed) return { valid: false, fields: null };
  const expected = await mintCode(parsed.fields, sign);
  return { valid: expected === parsed.code, fields: parsed.fields };
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run tests/training-receipt.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 6: Stage (do NOT commit)**

```bash
git add src/training/receipt.js src/training/hmac.js src/training/receiptKey.js tests/training-receipt.test.js
```

---

### Task 6: Storage and gate modules

**Files:**
- Create: `src/training/storage.js`, `src/training/gate.js`
- Test: `tests/training-storage.test.js`

**Interfaces:**
- Consumes: `progress.js` `migrate`.
- Produces: `UNLOCK_KEY`, `PROGRESS_KEY`, `MAX_ORGS`, `pruneOrgs(all, keepOrigin, max)`, `readProgress(origin, track)`, `writeProgress(origin, next)`, `clearProgress(origin)`; `isUnlocked()`, `onUnlockChange(cb)` → unsubscribe.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-storage.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PROGRESS_KEY, UNLOCK_KEY, MAX_ORGS, pruneOrgs, readProgress, writeProgress, clearProgress,
} from '../src/training/storage.js';
import { isUnlocked, onUnlockChange } from '../src/training/gate.js';

const TRACK = { id: 't', version: 2, missions: [{ id: 'm1', steps: [{ id: 'm1.s1', kind: 'visit' }] }] };
let state;
let listeners;

beforeEach(() => {
  state = {};
  listeners = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of wanted) if (k in state) out[k] = state[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(state, obj); }),
      },
      onChanged: {
        addListener: vi.fn((fn) => listeners.push(fn)),
        removeListener: vi.fn((fn) => { listeners = listeners.filter((l) => l !== fn); }),
      },
    },
  };
});

describe('pruneOrgs', () => {
  it('keeps the newest MAX_ORGS entries and always the active one', () => {
    const all = {
      a: { startedAt: 1 }, b: { startedAt: 2 }, c: { startedAt: 3 }, d: { startedAt: 4 },
    };
    const kept = pruneOrgs(all, 'a', 3);
    expect(Object.keys(kept).sort()).toEqual(['a', 'c', 'd']);
  });

  it('is a no-op below the cap', () => {
    const all = { a: { startedAt: 1 } };
    expect(pruneOrgs(all, 'a', MAX_ORGS)).toEqual(all);
  });

  // The cap itself must be asserted: an implementation that keeps the newest
  // `max` and then adds the active origin returns max+1 and would otherwise
  // pass the two tests above.
  it('never returns more than max entries, even when the active org is the oldest', () => {
    const all = { a: { startedAt: 1 }, b: { startedAt: 2 }, c: { startedAt: 3 }, d: { startedAt: 4 } };
    expect(Object.keys(pruneOrgs(all, 'a', 3))).toHaveLength(3);
    expect(Object.keys(pruneOrgs(all, 'a', 3))).toContain('a');
  });
});

describe('readProgress / writeProgress', () => {
  it('returns null when the org has no progress', async () => {
    expect(await readProgress('https://x.rossum.app', TRACK)).toBe(null);
  });

  it('round-trips progress for one org', async () => {
    await writeProgress('https://x.rossum.app', { trackId: 't', trackVersion: 2, missions: {} });
    const got = await readProgress('https://x.rossum.app', TRACK);
    expect(got.trackId).toBe('t');
    expect(state[PROGRESS_KEY]['https://x.rossum.app']).toBeTruthy();
  });

  it('migrates on read when the stored track version is older', async () => {
    state[PROGRESS_KEY] = { 'https://x.rossum.app': {
      trackId: 't', trackVersion: 1, missions: { m1: { steps: { GONE: { state: 'passed' } } } } } };
    const got = await readProgress('https://x.rossum.app', TRACK);
    expect(got.trackVersion).toBe(2);
    expect(got.missions.m1.steps.GONE).toBeUndefined();
  });

  it('keeps other orgs untouched on write', async () => {
    state[PROGRESS_KEY] = { 'https://a.rossum.app': { trackId: 't', startedAt: 1 } };
    await writeProgress('https://b.rossum.app', { trackId: 't', startedAt: 2 });
    expect(Object.keys(state[PROGRESS_KEY]).sort()).toEqual(['https://a.rossum.app', 'https://b.rossum.app']);
  });

  it('clearProgress removes only the given org', async () => {
    state[PROGRESS_KEY] = { a: { startedAt: 1 }, b: { startedAt: 2 } };
    await clearProgress('a');
    expect(Object.keys(state[PROGRESS_KEY])).toEqual(['b']);
  });
});

describe('gate', () => {
  it('is locked by default', async () => {
    expect(await isUnlocked()).toBe(false);
  });

  it('is unlocked when the key is true', async () => {
    state[UNLOCK_KEY] = true;
    expect(await isUnlocked()).toBe(true);
  });

  it('notifies on change and unsubscribes cleanly', async () => {
    const seen = [];
    const off = onUnlockChange((v) => seen.push(v));
    listeners.forEach((l) => l({ [UNLOCK_KEY]: { newValue: true } }, 'local'));
    listeners.forEach((l) => l({ somethingElse: { newValue: 1 } }, 'local'));
    listeners.forEach((l) => l({ [UNLOCK_KEY]: { newValue: true } }, 'sync'));
    expect(seen).toEqual([true]);
    off();
    expect(listeners).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-storage.test.js`
Expected: FAIL — cannot resolve `../src/training/storage.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/training/storage.js
// Thin chrome.storage.local layer. Progress is keyed by org ORIGIN (the
// rossumViewedAnnotations pattern) and capped, so a laptop that has visited
// many orgs does not accumulate state forever.
import { migrate } from './progress.js';

export const UNLOCK_KEY = 'trainingUnlocked';
export const PROGRESS_KEY = 'trainingProgress';
export const MAX_ORGS = 3;

// `max` is a hard cap on the result, and the active origin is always inside it.
// Reserving its slot BEFORE taking the newest is what keeps both true at once:
// taking the newest `max` and then adding the active origin would return
// `max + 1` entries whenever the active org is not among the newest.
export function pruneOrgs(all, keepOrigin, max = MAX_ORGS) {
  const entries = Object.entries(all || {});
  if (entries.length <= max) return all;
  const ranked = entries.sort((a, b) => (b[1]?.startedAt || 0) - (a[1]?.startedAt || 0));
  const kept = new Set(ranked.filter(([k]) => k !== keepOrigin).slice(0, max - 1).map(([k]) => k));
  kept.add(keepOrigin);
  const out = {};
  for (const [k, v] of entries) if (kept.has(k)) out[k] = v;
  return out;
}

async function readAll() {
  const got = await chrome.storage.local.get([PROGRESS_KEY]);
  return got?.[PROGRESS_KEY] || {};
}

export async function readProgress(origin, track) {
  const stored = (await readAll())[origin];
  if (!stored) return null;
  return migrate(track, stored);
}

export async function writeProgress(origin, next) {
  const all = await readAll();
  const merged = pruneOrgs({ ...all, [origin]: next }, origin);
  await chrome.storage.local.set({ [PROGRESS_KEY]: merged });
}

export async function clearProgress(origin) {
  const all = await readAll();
  delete all[origin];
  await chrome.storage.local.set({ [PROGRESS_KEY]: all });
}
```

```js
// src/training/gate.js
// The trainingUnlocked gate. Deliberately NOT experimentalUnlocked: that key
// gates Mr. Fabry, whose Architect implement loop defaults to write-enabled, and
// a trainee must not acquire an autonomous write capability against their org
// as a side effect of starting training.
import { UNLOCK_KEY } from './storage.js';

export async function isUnlocked() {
  const got = await chrome.storage.local.get([UNLOCK_KEY]);
  return got?.[UNLOCK_KEY] === true;
}

export function onUnlockChange(cb) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[UNLOCK_KEY]) return;
    cb(changes[UNLOCK_KEY].newValue === true);
  };
  chrome.storage.onChanged?.addListener(listener);
  return () => chrome.storage.onChanged?.removeListener(listener);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/training-storage.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/training/storage.js src/training/gate.js tests/training-storage.test.js
```

---

### Task 7: Live-verification gates

**Files:**
- Create: `docs/superpowers/specs/2026-08-07-partner-onboarding-training-verification.md`
- Modify (only if a finding requires it): `src/devtools/detect.js`, `src/training/track.js`, `src/training/steps.js`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: a findings document, and any corrections it forces. **No later task may assume an answer that this task has not recorded.**

This task writes no feature code. It answers the spec's §10 questions against a **live internal org only** — never a customer org, and no customer names or data may enter the findings document. Record hostnames as `<org>.rossum.app`.

- [ ] **Step 1: Open a logged-in Rossum tab**

Either ask the owner to run the snippets below in their browser console on a logged-in internal org, or drive it with the repo's verified dogfood recipe:

```bash
npm run build
agent-browser open "chrome://extensions"        # confirm dist/ is loaded unpacked
```

- [ ] **Step 2: G1 — are nav items real anchors?**

Run in the page console of a logged-in Rossum tab:

```js
JSON.stringify([...document.querySelectorAll('a[href]')]
  .map((a) => a.getAttribute('href'))
  .filter((h) => /^\/(documents|queues|extensions|settings|automation)/.test(h))
  .slice(0, 30));
```

Record: do hrefs exist for `/documents`, `/queues/…`, `/extensions/my-extensions`? If **no** anchors are found, delete the `anchor` key from every step in `src/training/track.js` — Task 11 then renders no arrow, and the card's text hint carries the step. Do not substitute class-based selectors.

- [ ] **Step 3: G2 — Data Storage reachable same-origin**

```js
await (await fetch('/svc/data-storage/api/v1/data/list_collections', {
  headers: { Authorization: `Token ${localStorage.getItem('secureToken')}` },
})).status;
```

Record the status and, on 200, the response shape (`collections` array or `results` array). If it is not same-origin or not reachable, change `m5.s2` in `track.js` from `kind: 'api'` to `kind: 'self'`, delete `collectionAdded` from `steps.js`, and **skip the allowlist widening in Task 8** — that widening exists only for this check.

- [ ] **Step 4: G3 — rules list shape**

```js
const r = await (await fetch('/api/v1/rules?page_size=1', {
  headers: { Authorization: `Token ${localStorage.getItem('secureToken')}` },
})).json();
JSON.stringify({ status: 'ok', keys: Object.keys(r), first: r.results?.[0] && Object.keys(r.results[0]) });
```

Record whether `results[].id` is a number. If rules are not listable for a normal user role, change `m4.s2` to `kind: 'self'` and delete `ruleCreated`.

- [ ] **Step 4b: G3b — schemas list**

```js
const s = await (await fetch('/api/v1/schemas?page_size=1', {
  headers: { Authorization: `Token ${localStorage.getItem('secureToken')}` },
})).json();
JSON.stringify({ keys: Object.keys(s), firstHasContent: Array.isArray(s.results?.[0]?.content) });
```

`schemaFieldAdded` counts fields across `results[].content[].children`. If the list endpoint is not available to a normal role, change `m2.s2` to `kind: 'self'` and delete `schemaFieldAdded` from `steps.js`.

**Also record the nesting shape** (raised by the Task 2 review). `baseline.js` `fieldCount` currently counts only `content[].children.length` — one level. If a real schema nests deeper (a line-item table's columns typically live under a `multivalue` → `tuple` → `children`), a trainee who adds a table column would never tick `m2.s2`, with no explanation. Print one real schema's nesting:

```js
const s = await (await fetch('/api/v1/schemas?page_size=1', {
  headers: { Authorization: `Token ${localStorage.getItem('secureToken')}` },
})).json();
JSON.stringify(s.results[0].content.map((sec) => ({
  category: sec.category,
  children: (sec.children || []).map((c) => ({ category: c.category, hasChildren: !!c.children })),
})));
```

If any child has `hasChildren: true`, change `fieldCount` to recurse — count every node carrying an `id` at any depth, tolerating `children` being either an array or a single object. The existing `fieldCount` test fixture must keep returning 3 unchanged; add a nested fixture alongside it.

- [ ] **Step 5: G4 — user identity for the receipt**

```js
const u = await (await fetch('/api/v1/auth/user/', {
  headers: { Authorization: `Token ${localStorage.getItem('secureToken')}` },
})).json();
JSON.stringify({ hasNumericId: Number.isInteger(u.id), hasUsername: typeof u.username === 'string' });
```

Both must be true. If `id` is absent, Task 15 must derive it from `u.url` with the same `/(\d+)\/?$/` extraction `baseline.js` uses.

- [ ] **Step 6: G5 — `chrome.storage.onChanged` inside a content script**

With the unpacked extension loaded, run in a Rossum tab's console:

```js
chrome.storage.local.set({ trainingUnlocked: true });
```

Then confirm from the extension's content-script context that a listener fires (temporarily `console.log` from `onUnlockChange` during this probe, and remove the log afterwards). If it does not fire, Task 12 reads the gate at init only, and the card appears on the next page load — note that in the findings.

- [ ] **Step 7: G6 — routes the syllabus needs**

For every `visit` step in `track.js`, navigate there and record the real URL. Any route not already in `src/devtools/detect.js` `ROUTES` must be added **with the observed URL as evidence**, following that file's header rule, together with a case in `tests/devtools-detect.test.js`.

- [ ] **Step 8: Write the findings document**

Create `docs/superpowers/specs/2026-08-07-partner-onboarding-training-verification.md` with one section per gate: the command run, the raw answer, the decision taken. Mark anything not verified as **NOT VERIFIED** — never infer.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS. If a `track.js` edit broke `tests/training-track.test.js`, fix the data, not the test.

- [ ] **Step 10: Stage (do NOT commit)**

```bash
git add docs/superpowers/specs/2026-08-07-partner-onboarding-training-verification.md
git add src/training/track.js src/training/steps.js src/devtools/detect.js tests/devtools-detect.test.js 2>/dev/null || true
```

---

### Task 8: Fresh API reads from the content script

**Files:**
- Modify: `src/rossum/api.js`
- Test: `tests/rossum-api-fresh.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `fetchRossumApiFresh(path, { ttlMs })` → `Promise<any>`; the existing `fetchRossumApi` keeps its exact current behaviour.

- [ ] **Step 1: Write the failing test**

```js
// tests/rossum-api-fresh.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRossumApiFresh } from '../src/rossum/api.js';

beforeEach(() => {
  window.localStorage.setItem('secureToken', 'tok');
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ n: 1 }) }));
});

describe('fetchRossumApiFresh', () => {
  it('sends the page token to a same-origin api path', async () => {
    await fetchRossumApiFresh('/api/v1/queues?page_size=100', { ttlMs: 0 });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`${window.location.origin}/api/v1/queues?page_size=100`);
    expect(init.headers.Authorization).toBe('Token tok');
  });

  it('allows the one Data Storage prefix and sends it as a Bearer POST', async () => {
    await fetchRossumApiFresh('/svc/data-storage/api/v1/collections/list',
      { ttlMs: 0, method: 'POST', body: { nameOnly: true }, auth: 'bearer' });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`${window.location.origin}/svc/data-storage/api/v1/collections/list`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok'); // NOT `Token`
    expect(JSON.parse(init.body)).toEqual({ nameOnly: true });
  });

  it('rejects percent-encoded traversal that would resolve outside the allowlist', async () => {
    // `new URL` decodes %2e%2e into real `..` and normalises it away, so a
    // literal `..` check alone lets this through: it resolves to /admin.
    await expect(fetchRossumApiFresh('/api/v1/%2e%2e/%2e%2e/admin', { ttlMs: 0 }))
      .rejects.toThrow(/Invalid API path/);
    await expect(fetchRossumApiFresh('/svc/data-storage/api/v1/%2e%2e/other', { ttlMs: 0 }))
      .rejects.toThrow(/Invalid API path/);
  });

  it('rejects any other service prefix', async () => {
    await expect(fetchRossumApiFresh('/svc/other/thing', { ttlMs: 0 })).rejects.toThrow(/Invalid API path/);
    await expect(fetchRossumApiFresh('https://evil.example/api/v1/x', { ttlMs: 0 })).rejects.toThrow();
    await expect(fetchRossumApiFresh('/api/v1/../../x', { ttlMs: 0 })).rejects.toThrow();
  });

  it('serves from cache inside the ttl and re-fetches after it', async () => {
    let now = 1000;
    const clock = () => now;
    await fetchRossumApiFresh('/api/v1/queues', { ttlMs: 100, now: clock });
    await fetchRossumApiFresh('/api/v1/queues', { ttlMs: 100, now: clock });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    now = 1200;
    await fetchRossumApiFresh('/api/v1/queues', { ttlMs: 100, now: clock });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not share a cache entry between a GET and a POST on the same path', async () => {
    // Without method/body in the key this collides and the POST is served the
    // GET's response. Every other test in this file uses a distinct path, so
    // nothing else would catch a regression to a path-only key.
    const p = '/svc/data-storage/api/v1/collections/list';
    await fetchRossumApiFresh(p, { ttlMs: 10_000 });
    await fetchRossumApiFresh(p, { ttlMs: 10_000, method: 'POST', body: { nameOnly: true }, auth: 'bearer' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const methods = globalThis.fetch.mock.calls.map(([, init]) => init.method || 'GET');
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('dedupes concurrent calls for the same path', async () => {
    await Promise.all([
      fetchRossumApiFresh('/api/v1/hooks', { ttlMs: 1000 }),
      fetchRossumApiFresh('/api/v1/hooks', { ttlMs: 1000 }),
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(fetchRossumApiFresh('/api/v1/rules', { ttlMs: 1000 })).rejects.toThrow(/API 500/);
    await expect(fetchRossumApiFresh('/api/v1/rules', { ttlMs: 1000 })).rejects.toThrow(/API 500/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/rossum-api-fresh.test.js`
Expected: FAIL — `fetchRossumApiFresh is not a function`.

- [ ] **Step 3: Modify `src/rossum/api.js`**

Replace the `safeApiUrl` function and append the new export. Leave `fetchRossumApi` untouched.

Widen the allowlist by **exactly one** prefix and give the fetcher optional
request options. Both exist for a single caller: the `collectionAdded` check,
whose endpoint is a POST authenticated with `Bearer` rather than `Token`
(verified live 2026-08-07 — it answers 401, not 404, unauthenticated).

Replace `safeApiUrl` with this, adding the prefix as an explicit allowlist entry
— never by relaxing the traversal or scheme checks below it:

```js
// Allowlisted path prefixes. /svc/data-storage/api/v1/ is here for the training
// track's master-data check ONLY. Widen this list one deliberate entry at a
// time, and never by loosening the checks that follow.
const ALLOWED_PREFIXES = ['/api/v1/', '/svc/data-storage/api/v1/'];

function safeApiUrl(path) {
  if (typeof path !== 'string') return null;
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) return null;
  if (path.includes('..') || path.includes('//')) return null;
  const url = new URL(path, window.location.origin);
  // Re-check the RESOLVED url, not just the raw string. `new URL` decodes
  // percent-encoded dot segments (`%2e%2e`) into real `..` and normalises them
  // away, so the literal pre-parse check above can be walked straight out of
  // the allowlist — `/api/v1/%2e%2e/%2e%2e/admin` resolves to `/admin`. The
  // origin check is belt-and-braces: dot-segment removal only rewrites the
  // path, never the host, but a token-bearing fetch is worth two guards.
  if (url.origin !== window.location.origin) return null;
  if (!ALLOWED_PREFIXES.some((p) => url.pathname.startsWith(p))) return null;
  return url.toString();
}
```

Then append the new export:

```js
// Short-TTL sibling of fetchRossumApi. The cache above never expires, which is
// right for ID overlays and wrong for polling a training step, so training gets
// its own cache with an explicit lifetime and in-flight dedupe. Token handling
// and URL safety stay here, in the one module that owns them.
const freshCache = new Map(); // path → { at, promise }

export function fetchRossumApiFresh(
  path,
  { ttlMs = 10_000, now = () => Date.now(), method = 'GET', body, auth = 'token' } = {},
) {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  // The cache key includes the method and body: a POST check and a GET on the
  // same path are different requests and must not share an entry.
  const key = method === 'GET' ? path : `${method} ${path} ${JSON.stringify(body ?? null)}`;
  const hit = freshCache.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.promise;

  const token = window.localStorage.getItem('secureToken');
  // Data Storage authenticates with Bearer; the Rossum API with Token. Getting
  // this wrong is a 401, not a failure you can see in the UI.
  const scheme = auth === 'bearer' ? 'Bearer' : 'Token';
  const headers = token ? { Authorization: `${scheme} ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const promise = fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    .then((r) => {
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    })
    .catch((err) => {
      freshCache.delete(key); // a failure must never be served from cache
      throw err;
    });
  freshCache.set(key, { at: now(), promise });
  return promise;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/rossum-api-fresh.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify no regression in the existing client**

Run: `npm test`
Expected: PASS — in particular every existing `resource-ids` test.

- [ ] **Step 6: Stage (do NOT commit)**

```bash
git add src/rossum/api.js tests/rossum-api-fresh.test.js
```

---

### Task 9: Popup — unlock counter and Training section

**Files:**
- Modify: `src/popup/components/App.jsx`, `src/popup/popup.css`
- Test: `tests/popup-training-gate.test.js`

**Interfaces:**
- Consumes: `src/popup/experimental.js` `createUnlockCounter`, `src/training/storage.js` `UNLOCK_KEY`.
- Produces: a popup that flips `trainingUnlocked` on 5 quick clicks of the header extension name, and shows a Training section while unlocked.

- [ ] **Step 1: Write the failing test**

```js
// tests/popup-training-gate.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h } from 'preact';
import { trainingUnlockTarget, TrainingSection } from '../src/popup/components/App.jsx';
import { render } from 'preact';
import { UNLOCK_KEY } from '../src/training/storage.js';

async function waitFor(cond, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let state;
beforeEach(() => {
  state = {};
  globalThis.chrome = { storage: { local: {
    get: vi.fn(async () => ({ ...state })),
    set: vi.fn(async (obj) => Object.assign(state, obj)),
  } } };
  document.body.innerHTML = '';
});

describe('trainingUnlockTarget', () => {
  it('flips the key only on the fifth quick click', async () => {
    const onFlip = vi.fn();
    const click = trainingUnlockTarget({ onFlip });
    for (let i = 0; i < 4; i++) await click(false);
    expect(onFlip).not.toHaveBeenCalled();
    await click(false);
    expect(onFlip).toHaveBeenCalledWith(true);
  });

  it('toggles back off from an unlocked state', async () => {
    const onFlip = vi.fn();
    const click = trainingUnlockTarget({ onFlip });
    for (let i = 0; i < 5; i++) await click(true);
    expect(onFlip).toHaveBeenCalledWith(false);
  });

  it('writes trainingUnlocked straight to storage, never via the worker', async () => {
    const click = trainingUnlockTarget({});
    for (let i = 0; i < 5; i++) await click(false);
    await waitFor(() => state[UNLOCK_KEY] === true);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [UNLOCK_KEY]: true });
  });
});

describe('TrainingSection', () => {
  it('renders nothing while locked', () => {
    render(h(TrainingSection, { unlocked: false, onOpenAcademy: () => {} }), document.body);
    expect(document.body.textContent).toBe('');
  });

  it('offers the Academy while unlocked', async () => {
    const onOpenAcademy = vi.fn();
    render(h(TrainingSection, { unlocked: true, onOpenAcademy }), document.body);
    await waitFor(() => document.body.textContent.includes('Training'));
    const btn = [...document.querySelectorAll('button')].find((b) => /Academy/.test(b.textContent));
    btn.click();
    expect(onOpenAcademy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/popup-training-gate.test.js`
Expected: FAIL — `trainingUnlockTarget` is not exported.

- [ ] **Step 3: Add the exports to `src/popup/components/App.jsx`**

Add near `createUnlockCounter`'s existing import site:

```jsx
import { UNLOCK_KEY } from '../../training/storage.js';

// Second easter egg: 5 quick clicks on the extension NAME (not the version
// hash) flip trainingUnlocked. Deliberately a different key from
// experimentalUnlocked — that one gates Mr. Fabry, whose Architect implement
// loop defaults to write-enabled, and a partner trainee must not acquire an
// autonomous write capability just by starting training.
export function trainingUnlockTarget({ onFlip } = {}) {
  const counter = createUnlockCounter();
  return async (currentlyUnlocked) => {
    if (!counter.click()) return;
    const next = !currentlyUnlocked;
    await chrome.storage.local.set({ [UNLOCK_KEY]: next });
    onFlip?.(next);
  };
}

export function TrainingSection({ unlocked, onOpenAcademy }) {
  if (!unlocked) return null;
  return (
    <section class="section">
      <h2 class="section-title">Training</h2>
      <p class="section-hint">Guided onboarding track with a completion receipt.</p>
      <button class="link-button" onClick={onOpenAcademy}>Open the Academy</button>
    </section>
  );
}
```

In the component body, add `const [trainingUnlocked, setTrainingUnlocked] = useState(false);` and load `UNLOCK_KEY` alongside the existing storage read.

Build the click handler with **lazy state init, not a bare `const`**:

```jsx
  const [onNameClick] = useState(() => trainingUnlockTarget({ onFlip: setTrainingUnlocked }));
```

A plain `const onNameClick = trainingUnlockTarget(...)` in the render body constructs a **new counter on every re-render**, resetting the click streak — so the five clicks could never accumulate.

Attach it to the header name element as `onClick={() => onNameClick(trainingUnlocked)}`.

Open the Academy through the file's existing auth flow — `openConsoleTab`'s real signature is `(tab, authData, app)`, so it cannot be called with an app name alone:

```jsx
  const onOpenAcademy = () => fetchAuthAndOpen((tab, auth) => openConsoleTab(tab, auth, 'academy'));
```

Then render `<TrainingSection unlocked={trainingUnlocked} onOpenAcademy={onOpenAcademy} />` inside the Rossum branch. Until Task 16 teaches `boot.js` the `'academy'` app id, this button opens the Console on Dataset Management — expected, not a defect.

- [ ] **Step 4: Add the styles**

Append to `src/popup/popup.css`:

`TrainingSection` uses `.section`, `.section-title`, `.section-hint` and `.link-button`. Only `.section-title` already exists in this stylesheet, so the other three need rules — an unstyled `<button>` renders as a bare OS-default control, visually unlike every other action in this popup (`.console-btn`, `.mdh-btn`). Reuse the accent-button convention rather than inventing a new look:

```css
/* ── Training section (only rendered while trainingUnlocked) ─ */

.section {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}

.section-hint {
  margin: 2px 0 8px;
  font-size: 11px;
  opacity: 0.75;
}

.link-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  background: var(--accent);
  border: 1px solid var(--accent-dim);
  border-radius: 6px;
  color: #fff;
  font-family: var(--font-sans);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}

.link-button:hover {
  background: var(--accent-dim);
  box-shadow: 0 2px 6px rgba(66, 112, 219, 0.35);
}
```

Before adding `.section`, confirm no existing rule or element selector already claims that class — if one does, rename the wrapper class rather than overriding shared styling.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run tests/popup-training-gate.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS, build clean.

- [ ] **Step 7: Stage (do NOT commit)**

```bash
git add src/popup/components/App.jsx src/popup/popup.css tests/popup-training-gate.test.js
```

---

### Task 10: The quest card

> **Plan-text status (recorded 2026-08-07).** The shipped `tests/training-quest.test.js` has moved
> ahead of the code block below: every test loads its own module instance via the `loadQuest()`
> helper (`vi.resetModules()` + dynamic import), because `training-quest.js` keeps deliberate
> module-level state that must survive a page's lifetime. It also carries two tests not shown here —
> `production wiring` (the real fetcher receives the check options) and `unlock re-entry` (a repeated
> unlock must not stack a tick loop). **Treat the implementation as authoritative over this section**,
> and do not regenerate a brief from it without re-applying that isolation — doing so silently
> reverts it. This is a plan/code divergence recorded rather than hidden.


**Files:**
- Create: `src/rossum/features/training-quest.js`
- Test: `tests/training-quest.test.js`

**Interfaces:**
- Consumes: `track.js`, `progress.js`, `steps.js`, `baseline.js`, `storage.js`, `gate.js`, `src/rossum/api.js` `fetchRossumApiFresh`.
- Produces: `init(deps)` where `deps = { getLocation, get, now, intervalMs }` (all injected for tests); `CARD_ID`, `renderCard(state)`, `nextStep(track, progress)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-quest.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init, CARD_ID, nextStep } from '../src/rossum/features/training-quest.js';
import { TRACK } from '../src/training/track.js';
import { emptyProgress, markStep } from '../src/training/progress.js';
import { PROGRESS_KEY, UNLOCK_KEY } from '../src/training/storage.js';

async function waitFor(cond, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Each test gets its OWN module instance. training-quest.js keeps deliberate
// module-level state (started / gateListenerOn / intervalHandle) that must
// survive for the page's lifetime in production — it is what stops a second
// init() stacking a tick loop — so a single shared import would leak that state
// between tests, break some and make others pass for the wrong reason.
// Isolate the harness; never add a reset export just to serve it.
async function loadQuest() {
  vi.resetModules();
  return import('../src/rossum/features/training-quest.js');
}

let state;
beforeEach(() => {
  state = {};
  document.body.innerHTML = '';
  globalThis.chrome = { storage: {
    local: {
      get: vi.fn(async (keys) => {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in state) out[k] = state[k];
        return out;
      }),
      set: vi.fn(async (obj) => Object.assign(state, obj)),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  } };
});

const deps = (over = {}) => ({
  getLocation: () => ({ pathname: '/documents', search: '?level=all' }),
  get: vi.fn(async () => ({ results: [] })),
  now: () => 1000,
  intervalMs: 0,
  ...over,
});

describe('production wiring', () => {
  it('forwards the check options to the real fetcher (POST/Bearer must survive)', async () => {
    vi.resetModules();
    const fetchRossumApiFresh = vi.fn(async () => ({ results: [] }));
    vi.doMock('../src/rossum/api.js', () => ({ fetchRossumApiFresh }));
    const { init: freshInit } = await import('../src/rossum/features/training-quest.js');
    state[UNLOCK_KEY] = true;
    // Start on the mission whose first unfinished step is API-kind so a check runs.
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) {
      for (const s of m.steps) {
        if (m.id === 'm1' || (m.id === 'm2' && s.kind !== 'api')) p = markStep(p, m.id, s.id, 'passed', 2);
      }
    }
    state[PROGRESS_KEY] = { [window.location.origin]: p };
    await freshInit({ getLocation: () => ({ pathname: '/nowhere', search: '' }), now: () => 1000, intervalMs: 0 });
    await waitFor(() => fetchRossumApiFresh.mock.calls.length > 0);
    const [, opts] = fetchRossumApiFresh.mock.calls[0];
    expect(opts).toBeDefined();          // the second argument must survive
    expect(opts.id).toBeTruthy();        // it is the check object
    vi.doUnmock('../src/rossum/api.js');
  });
});

describe('gate', () => {
  it('injects nothing while locked', async () => {
    await init(deps());
    expect(document.getElementById(CARD_ID)).toBe(null);
  });

  it('never fetches while locked', async () => {
    const d = deps();
    await init(d);
    expect(d.get).not.toHaveBeenCalled();
  });
});

describe('card', () => {
  beforeEach(() => { state[UNLOCK_KEY] = true; });

  it('injects the card when unlocked and a track is started', async () => {
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    await init(deps());
    await waitFor(() => document.getElementById(CARD_ID));
    expect(document.getElementById(CARD_ID).textContent).toContain('Orientation');
  });

  it('uses no innerHTML anywhere in the card', async () => {
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    await init(deps());
    await waitFor(() => document.getElementById(CARD_ID));
    // A hint containing markup characters must land as text, never as elements.
    expect(document.getElementById(CARD_ID).querySelector('script')).toBe(null);
  });

  it('marks a visit step passed when the route matches', async () => {
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    await init(deps());
    await waitFor(() => state[PROGRESS_KEY][window.location.origin].missions?.m1?.steps?.['m1.s1']);
    expect(state[PROGRESS_KEY][window.location.origin].missions.m1.steps['m1.s1'].state).toBe('passed');
  });

  it('does not mark a visit step when the route does not match', async () => {
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    await init(deps({ getLocation: () => ({ pathname: '/nowhere', search: '' }) }));
    // intervalMs:0 means all work is flushed by the time init() resolves —
    // no sleep needed, and a fixed-timeout wait would be a repo-rule violation.
    expect(state[PROGRESS_KEY][window.location.origin].missions?.m1?.steps?.['m1.s1']).toBeUndefined();
  });

  // Drives a REAL tick after dismissal, via the focus listener. An earlier
  // version of this test called init() a second time, which proved nothing:
  // `if (started) return` makes a second init inert whether or not the card was
  // ever dismissed, so it passed for the wrong reason. The observable proof
  // that the dismissed path ran is stop() clearing the interval.
  it('a tick after dismissal renders nothing, stops the loop and makes no API call', async () => {
    const { init, CARD_ID } = await loadQuest();
    state[UNLOCK_KEY] = true;
    state[PROGRESS_KEY] = { [window.location.origin]: emptyProgress(TRACK, 1) };
    const d = deps({ intervalMs: 50 }); // a real interval, so stop() has one to clear
    await init(d);
    await waitFor(() => document.getElementById(CARD_ID));

    document.querySelector(`#${CARD_ID} .rossum-sa-extension-tq-close`).click();
    expect(document.getElementById(CARD_ID)).toBe(null);
    const callsAtDismiss = d.get.mock.calls.length;

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    window.dispatchEvent(new Event('focus')); // the listener init() registered runs tick()
    await waitFor(() => clearSpy.mock.calls.length > 0); // the dismissed branch really ran

    expect(document.getElementById(CARD_ID)).toBe(null);
    expect(d.get.mock.calls.length).toBe(callsAtDismiss); // no polling after dismissal
    clearSpy.mockRestore();
  });
});

describe('nextStep', () => {
  it('returns the first unfinished step of the active mission', () => {
    const p = emptyProgress(TRACK, 1);
    expect(nextStep(TRACK, p).step.id).toBe('m1.s1');
    const p2 = markStep(p, 'm1', 'm1.s1', 'passed', 2);
    expect(nextStep(TRACK, p2).step.id).toBe('m1.s2');
  });

  it('returns null when the whole track is done', () => {
    let p = emptyProgress(TRACK, 1);
    for (const m of TRACK.missions) for (const s of m.steps) p = markStep(p, m.id, s.id, 'passed', 3);
    expect(nextStep(TRACK, p)).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-quest.test.js`
Expected: FAIL — cannot resolve the feature module.

- [ ] **Step 3: Write the implementation**

```js
// src/rossum/features/training-quest.js
// The bottom-right quest card. Injects nothing and fetches nothing until the
// gate is unlocked AND a track has been started, so a locked profile pays for
// one storage read and one listener.
//
// Verification is URL + read-only API state — never click-tracking, and the
// extension never writes to the org.
import { TRACK } from '../../training/track.js';
import {
  emptyProgress, markStep, startMission, missionStatus, stepState,
  xpFor, levelFor, badges, isMissionComplete,
} from '../../training/progress.js';
import { CHECKS, evaluateVisit, evaluateApi, signatureFor } from '../../training/steps.js';
import { readProgress, writeProgress } from '../../training/storage.js';
import { isUnlocked, onUnlockChange } from '../../training/gate.js';
import { fetchRossumApiFresh } from '../api.js';
import { showPointer, hidePointer } from './training-pointer.js';

export const CARD_ID = 'rossum-sa-extension-training-card';
const STYLE_ID = 'rossum-sa-extension-training-style';
const DISMISS_KEY = 'rossum-sa-extension-training-dismissed';
const API_MIN_INTERVAL_MS = 20_000;

export function nextStep(track, progress) {
  for (const m of track.missions) {
    if (missionStatus(track, progress, m.id) !== 'active') continue;
    for (const s of m.steps) {
      const st = stepState(progress, m.id, s.id);
      if (st !== 'passed' && st !== 'self') return { mission: m, step: s };
    }
  }
  return null;
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${CARD_ID} {
  position: fixed; bottom: 16px; right: 16px; z-index: 2147483645; width: 268px;
  box-sizing: border-box; padding: 12px 13px; border-radius: 11px; color: #fff;
  background: linear-gradient(150deg, #2f4fa8, #4270db 55%, #5b8af0);
  box-shadow: 0 8px 26px rgba(20, 30, 60, 0.32);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px; line-height: 1.4;
}
#${CARD_ID} .rossum-sa-extension-tq-head { display: flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: .04em; opacity: .9; }
#${CARD_ID} .rossum-sa-extension-tq-close { margin-left: auto; background: none; border: 0;
  color: #fff; font-size: 16px; line-height: 1; cursor: pointer; opacity: .8; padding: 0 2px; }
#${CARD_ID} .rossum-sa-extension-tq-mission { font-weight: 800; margin: 6px 0 2px; }
#${CARD_ID} .rossum-sa-extension-tq-bar { height: 5px; border-radius: 3px; margin: 8px 0 4px;
  background: rgba(255,255,255,.26); overflow: hidden; }
#${CARD_ID} .rossum-sa-extension-tq-bar i { display: block; height: 100%; background: #9be8c4; }
#${CARD_ID} ul { list-style: none; margin: 6px 0 0; padding: 0; }
#${CARD_ID} li { display: flex; gap: 6px; margin-bottom: 4px; font-size: 11px; }
#${CARD_ID} li.rossum-sa-extension-tq-done { opacity: .65; }
#${CARD_ID} li.rossum-sa-extension-tq-now { font-weight: 700; }
#${CARD_ID} .rossum-sa-extension-tq-foot { display: flex; justify-content: space-between;
  font-size: 10px; font-weight: 700; margin-top: 8px; opacity: .92; }`;
  (document.head || document.documentElement)?.appendChild(style);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // never innerHTML
  return n;
}

function renderCard(progress, active) {
  document.getElementById(CARD_ID)?.remove();
  if (!active) return;
  injectStyle();
  const card = el('div');
  card.id = CARD_ID;

  const head = el('div', 'rossum-sa-extension-tq-head');
  head.appendChild(el('span', null, '✦ TRAINING'));
  const close = el('button', 'rossum-sa-extension-tq-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss for this session');
  close.addEventListener('click', () => {
    try { window.sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    hidePointer();
    card.remove();
  });
  head.appendChild(close);
  card.appendChild(head);

  card.appendChild(el('div', 'rossum-sa-extension-tq-mission', active.mission.title));

  const done = active.mission.steps.filter(
    (s) => ['passed', 'self'].includes(stepState(progress, active.mission.id, s.id))).length;
  const bar = el('div', 'rossum-sa-extension-tq-bar');
  const fill = el('i');
  fill.style.width = `${Math.round((done / active.mission.steps.length) * 100)}%`;
  bar.appendChild(fill);
  card.appendChild(bar);

  const list = el('ul');
  for (const s of active.mission.steps) {
    const st = stepState(progress, active.mission.id, s.id);
    const li = el('li', st ? 'rossum-sa-extension-tq-done'
      : s.id === active.step.id ? 'rossum-sa-extension-tq-now' : null);
    li.appendChild(el('span', null, st ? '✓' : '○'));
    li.appendChild(el('span', null, s.hint));
    list.appendChild(li);
  }
  card.appendChild(list);

  const foot = el('div', 'rossum-sa-extension-tq-foot');
  const xp = xpFor(TRACK, progress);
  foot.appendChild(el('span', null, `${xp} XP · Level ${levelFor(xp)}`));
  foot.appendChild(el('span', null, `★ ${badges(TRACK, progress).length}/${TRACK.missions.length}`));
  card.appendChild(foot);

  document.body.appendChild(card);
}

let started = false;        // never stack a second tick loop
let gateListenerOn = false; // never stack a second unlock listener
let intervalHandle = null;

export async function init(deps = {}) {
  const {
    getLocation = () => window.location,
    // MUST forward the options: the call sites pass the check object as the
    // second argument, and one check (collectionAdded) carries method/body/auth
    // on it. Dropping `opts` here sends that check as a Token-authed GET to a
    // Bearer POST endpoint — it fails silently in production while every test
    // that injects its own `get` still passes.
    get = (p, opts) => fetchRossumApiFresh(p, opts),
    now = () => Date.now(),
    intervalMs = 1500,
  } = deps;

  if (!(await isUnlocked())) {
    // One listener for the lifetime of the page. Without the guard, a trainee
    // toggling the gate stacks a listener per lock/unlock cycle, and each one
    // re-enters init.
    if (!gateListenerOn) {
      gateListenerOn = true;
      onUnlockChange((on) => { if (on) init(deps); });
    }
    return;
  }
  if (started) return; // re-entry via the unlock listener must not add a loop
  started = true;

  const origin = window.location.origin;
  let progress = await readProgress(origin, TRACK);
  if (!progress) { started = false; return; } // the track is started from the Academy
  let lastApiAt = 0;

  const save = async (next) => { progress = next; await writeProgress(origin, next); };

  function stop() {
    if (intervalHandle !== null) { clearInterval(intervalHandle); intervalHandle = null; }
    started = false;
    hidePointer();
  }

  async function tick() {
    // A session dismissal silences the feature completely: no render, no
    // pointer, and — the part that matters — no further network calls. The
    // trainee asked to be left alone; polling their org invisibly is not that.
    let dismissed = false;
    try { dismissed = !!window.sessionStorage.getItem(DISMISS_KEY); } catch { /* ignore */ }
    if (dismissed) { renderCard(progress, null); stop(); return; }

    let active = nextStep(TRACK, progress);
    if (!active) { renderCard(progress, null); hidePointer(); return; }

    if (progress.missions[active.mission.id]?.baseline == null) {
      const checks = active.mission.steps.filter((s) => s.kind === 'api').map((s) => CHECKS[s.check]);
      const baseline = {};
      let captured = true;
      for (const c of checks) {
        try {
          const responses = {};
          for (const p of c.paths) responses[p] = await get(p, c);
          baseline[c.id] = signatureFor(c.id, responses);
        } catch { captured = false; }
      }
      // Persist ONLY a complete baseline. A missing entry is permanent —
      // evaluateApi returns false forever for a check with no baseline — so
      // saving a half-captured snapshot would let one transient network blip
      // at mission start silently strand that step for the whole mission.
      // Leaving it uncaptured simply retries on the next tick.
      if (!captured) return;
      await save(startMission(progress, active.mission.id, baseline, now()));
      active = nextStep(TRACK, progress);
      if (!active) { renderCard(progress, null); hidePointer(); return; }
    }

    if (active.step.kind === 'visit' && evaluateVisit(active.step, getLocation())) {
      await save(markStep(progress, active.mission.id, active.step.id, 'passed', now()));
      active = nextStep(TRACK, progress);
    } else if (active.step.kind === 'api' && now() - lastApiAt > API_MIN_INTERVAL_MS) {
      lastApiAt = now();
      const c = CHECKS[active.step.check];
      try {
        const responses = {};
        for (const p of c.paths) responses[p] = await get(p, c);
        const sig = signatureFor(c.id, responses);
        if (evaluateApi(c, sig, progress.missions[active.mission.id]?.baseline?.[c.id])) {
          await save(markStep(progress, active.mission.id, active.step.id, 'passed', now()));
          active = nextStep(TRACK, progress);
        }
      } catch { /* transient — retry next tick */ }
    }

    renderCard(progress, active);
    if (active) showPointer(active.step.anchor); else hidePointer();
  }

  await tick();
  if (intervalMs > 0) intervalHandle = setInterval(tick, intervalMs);
  window.addEventListener('focus', () => { lastApiAt = 0; tick(); });
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/training-quest.test.js`
Expected: PASS, 8 tests. Task 11 creates `training-pointer.js`; until then this import fails, so create a stub first: `export const showPointer = () => {}; export const hidePointer = () => {};` in `src/rossum/features/training-pointer.js`.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/rossum/features/training-quest.js src/rossum/features/training-pointer.js tests/training-quest.test.js
```

---

### Task 11: The pointer arrow

**Files:**
- Modify: `src/rossum/features/training-pointer.js` (replacing the Task 10 stub)
- Test: `tests/training-pointer.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `showPointer(anchor, deps?)`, `hidePointer()`, `ARROW_ID`, `resolveAnchor(anchor, doc)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-pointer.test.js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { showPointer, hidePointer, ARROW_ID, resolveAnchor } from '../src/rossum/features/training-pointer.js';

beforeEach(() => {
  document.body.innerHTML = '';
  hidePointer();
});

describe('resolveAnchor', () => {
  it('finds an anchor by href substring', () => {
    document.body.innerHTML = '<a href="/extensions/my-extensions">Ext</a>';
    expect(resolveAnchor({ hrefIncludes: '/extensions/my-extensions' }, document).tagName).toBe('A');
  });

  it('returns null when nothing matches', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    expect(resolveAnchor({ hrefIncludes: '/extensions' }, document)).toBe(null);
  });

  it('never matches by class or id — hrefs only', () => {
    document.body.innerHTML = '<div class="extensions" id="extensions">x</div>';
    expect(resolveAnchor({ hrefIncludes: '/extensions' }, document)).toBe(null);
  });
});

describe('showPointer', () => {
  it('renders no arrow when the step has no anchor', () => {
    showPointer(undefined);
    expect(document.getElementById(ARROW_ID)).toBe(null);
  });

  it('renders no arrow when the anchor cannot be resolved', () => {
    showPointer({ hrefIncludes: '/nope' }, { retries: 0 });
    expect(document.getElementById(ARROW_ID)).toBe(null);
  });

  it('renders an arrow next to a resolved anchor', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    const arrow = document.getElementById(ARROW_ID);
    expect(arrow).toBeTruthy();
    expect(arrow.style.position).toBe('fixed');
  });

  it('never intercepts clicks', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    expect(document.getElementById(ARROW_ID).style.pointerEvents).toBe('none');
  });

  it('replaces rather than stacks arrows on repeated calls', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    expect(document.querySelectorAll(`#${ARROW_ID}`)).toHaveLength(1);
  });

  it('hidePointer removes it', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    hidePointer();
    expect(document.getElementById(ARROW_ID)).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-pointer.test.js`
Expected: FAIL — `resolveAnchor` is not exported (only the Task 10 stub exists).

- [ ] **Step 3: Write the implementation**

```js
// src/rossum/features/training-pointer.js
// A single arrow pointing at the current step's target.
//
// Anchoring is by HREF ONLY. The route contract is verified (see
// src/devtools/detect.js); Rossum's class names are not a contract this repo
// owns. If the anchor does not resolve, NO arrow renders and the card's text
// hint carries the step — a stale selector must never block a trainee.

export const ARROW_ID = 'rossum-sa-extension-training-arrow';
let cleanup = null;

export function resolveAnchor(anchor, doc = document) {
  if (!anchor?.hrefIncludes) return null;
  const esc = anchor.hrefIncludes.replace(/"/g, '\\"');
  return doc.querySelector(`a[href*="${esc}"]`);
}

export function hidePointer() {
  document.getElementById(ARROW_ID)?.remove();
  if (cleanup) { cleanup(); cleanup = null; }
}

export function showPointer(anchor, { retries = 6, delayMs = 300 } = {}) {
  hidePointer();
  if (!anchor?.hrefIncludes) return;

  let attempt = 0;
  const place = () => {
    const target = resolveAnchor(anchor);
    if (!target) {
      if (attempt++ < retries) { setTimeout(place, delayMs); return; }
      return; // SPA never rendered it — silently no arrow
    }
    const arrow = document.getElementById(ARROW_ID) || document.createElement('div');
    arrow.id = ARROW_ID;
    arrow.textContent = '◀';
    Object.assign(arrow.style, {
      position: 'fixed', zIndex: '2147483644', pointerEvents: 'none',
      color: '#ffd479', fontSize: '18px', lineHeight: '1',
      textShadow: '0 2px 6px rgba(0,0,0,.4)', transition: 'top .12s, left .12s',
    });
    if (!arrow.isConnected) document.body.appendChild(arrow);

    const reposition = () => {
      const r = target.getBoundingClientRect();
      arrow.style.top = `${r.top + r.height / 2 - 9}px`;
      arrow.style.left = `${r.right + 6}px`;
    };
    reposition();

    let frame = 0;
    const onScrollOrResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reposition);
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    cleanup = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  };
  place();
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/training-pointer.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/rossum/features/training-pointer.js tests/training-pointer.test.js
```

---

### Task 12: Wire the feature into the content script

**Files:**
- Modify: `src/rossum/index.js`
- Test: `tests/training-content-wiring.test.js`

**Interfaces:**
- Consumes: `training-quest.js` `init`.
- Produces: no new exports — the feature runs on content-script load, always-on like `track-viewed`, self-gated on `trainingUnlocked`.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-content-wiring.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const SRC = readFileSync('src/rossum/index.js', 'utf8');

describe('content script wiring', () => {
  it('imports and starts the training quest feature', () => {
    expect(SRC).toMatch(/import .*initTrainingQuest.* from '\.\/features\/training-quest\.js'/);
    expect(SRC).toMatch(/initTrainingQuest\(\)/);
  });

  it('starts it OUTSIDE the SETTINGS_KEYS block — it self-gates on trainingUnlocked', () => {
    const settingsIdx = SRC.indexOf('chrome.storage.local.get(SETTINGS_KEYS)');
    expect(SRC.indexOf('initTrainingQuest()')).toBeLessThan(settingsIdx);
  });

  it('does not add trainingUnlocked to SETTINGS_KEYS', () => {
    const block = SRC.slice(SRC.indexOf('SETTINGS_KEYS = ['), SRC.indexOf('];'));
    expect(block).not.toContain('trainingUnlocked');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-content-wiring.test.js`
Expected: FAIL — the import is missing.

- [ ] **Step 3: Modify `src/rossum/index.js`**

Add the import beside the other feature imports:

```js
import { init as initTrainingQuest } from './features/training-quest.js';
```

And call it with the other always-on features, above the `SETTINGS_KEYS` read:

```js
initClosableTooltips();
initDatasetMgmtSuggest();
initTrackViewed();
initTrainingQuest(); // self-gates on trainingUnlocked; no popup toggle
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/training-content-wiring.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS, build clean.

- [ ] **Step 6: Stage (do NOT commit)**

```bash
git add src/rossum/index.js tests/training-content-wiring.test.js
```

---

### Task 13: Academy store and init

**Files:**
- Create: `src/academy/store.js`, `src/academy/index.jsx`
- Test: `tests/academy-store.test.js`

**Interfaces:**
- Consumes: `track.js`, `storage.js`, `progress.js`.
- Produces: signals `connected`, `progress`, `activeMissionId`, `busy`, `error`, `receiptText`; `initAcademy()`; `startTrack()`, `refreshProgress()`, `setActiveMission(id)`, `attestStep(missionId, stepId)`, `restartTrack()`.

- [ ] **Step 1: Write the failing test**

```js
// tests/academy-store.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as store from '../src/academy/store.js';
import { PROGRESS_KEY } from '../src/training/storage.js';
import { TRACK } from '../src/training/track.js';

let state;
beforeEach(() => {
  state = {};
  globalThis.chrome = { storage: {
    local: {
      get: vi.fn(async (keys) => {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in state) out[k] = state[k];
        return out;
      }),
      set: vi.fn(async (obj) => Object.assign(state, obj)),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  } };
  store.setOrigin('https://x.rossum.app');
  store.progress.value = null;
  store.activeMissionId.value = null;
});

describe('startTrack', () => {
  it('creates empty progress for this org and selects the first mission', async () => {
    await store.startTrack();
    expect(store.progress.value.trackId).toBe(TRACK.id);
    expect(state[PROGRESS_KEY]['https://x.rossum.app']).toBeTruthy();
    expect(store.activeMissionId.value).toBe('m1');
  });

  it('does not overwrite existing progress', async () => {
    await store.startTrack();
    const started = store.progress.value.startedAt;
    await store.startTrack();
    expect(store.progress.value.startedAt).toBe(started);
  });
});

describe('attestStep', () => {
  it('marks a self step and persists it', async () => {
    await store.startTrack();
    await store.attestStep('m1', 'm1.s4');
    expect(state[PROGRESS_KEY]['https://x.rossum.app'].missions.m1.steps['m1.s4'].state).toBe('self');
  });

  it('refuses to attest a step that is not kind self', async () => {
    await store.startTrack();
    await store.attestStep('m1', 'm1.s1');
    expect(state[PROGRESS_KEY]['https://x.rossum.app'].missions?.m1?.steps?.['m1.s1']).toBeUndefined();
  });
});

describe('restartTrack', () => {
  it('clears only this org and resets the signals', async () => {
    state[PROGRESS_KEY] = { 'https://x.rossum.app': { trackId: 't' }, 'https://y.rossum.app': { trackId: 't' } };
    await store.restartTrack();
    expect(Object.keys(state[PROGRESS_KEY])).toEqual(['https://y.rossum.app']);
    expect(store.progress.value).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/academy-store.test.js`
Expected: FAIL — cannot resolve `../src/academy/store.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/academy/store.js
import { signal } from '@preact/signals';
import { TRACK } from '../training/track.js';
import { emptyProgress, markStep } from '../training/progress.js';
import { readProgress, writeProgress, clearProgress } from '../training/storage.js';

export const connected = signal(null); // null = unprobed
export const progress = signal(null);
export const activeMissionId = signal(null);
export const error = signal(null);
export const receiptText = signal(null);
// No `busy` signal: the only spinner is ReceiptPanel's, and it is component-local.

let origin = '';
export function setOrigin(value) { origin = value; }
export function getOrigin() { return origin; }

export async function refreshProgress() {
  progress.value = await readProgress(origin, TRACK);
  if (progress.value && !activeMissionId.value) activeMissionId.value = TRACK.missions[0].id;
  return progress.value;
}

export async function startTrack(now = Date.now) {
  const existing = await readProgress(origin, TRACK);
  if (existing) { progress.value = existing; activeMissionId.value ||= TRACK.missions[0].id; return; }
  const fresh = emptyProgress(TRACK, now());
  await writeProgress(origin, fresh);
  progress.value = fresh;
  activeMissionId.value = TRACK.missions[0].id;
}

export function setActiveMission(id) { activeMissionId.value = id; }

// Only a `self` step may be attested; everything else is evidence-backed.
export async function attestStep(missionId, stepId, now = Date.now) {
  const mission = TRACK.missions.find((m) => m.id === missionId);
  const step = mission?.steps.find((s) => s.id === stepId);
  if (!step || step.kind !== 'self' || !progress.value) return;
  const next = markStep(progress.value, missionId, stepId, 'self', now());
  await writeProgress(origin, next);
  progress.value = next;
}

export async function restartTrack() {
  await clearProgress(origin);
  progress.value = null;
  activeMissionId.value = null;
  receiptText.value = null;
}
```

```jsx
// src/academy/index.jsx
// Lazy entry point, mirroring initGalaxy/initInspector/initFabry. Auth reuses
// the Console's existing consoleAuth_<uuid> → sessionStorage credentials; the
// Academy adds no new auth path.
import * as store from './store.js';

let progressListenerOn = false;

export async function initAcademy() {
  const domain = sessionStorage.getItem('consoleDomain') || '';
  store.setOrigin(domain);
  try {
    await store.refreshProgress();
    store.connected.value = true;
  } catch (e) {
    store.error.value = String(e?.message || e);
    store.connected.value = false;
  }
  // Progress is written by the content script too — mirror it live. Guarded
  // against double-registration the way src/inspector/index.jsx guards its own
  // onChanged listener (`viewedListenerOn`): a second initAcademy() would
  // otherwise stack listeners silently, each firing its own refresh per change.
  if (!progressListenerOn) {
    progressListenerOn = true;
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes.trainingProgress) store.refreshProgress();
    });
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/academy-store.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Stage (do NOT commit)**

```bash
git add src/academy/store.js src/academy/index.jsx tests/academy-store.test.js
```

---

### Task 14: Academy mission map and detail

**Files:**
- Create: `src/academy/components/App.jsx`, `src/academy/components/MissionList.jsx`, `src/academy/components/MissionDetail.jsx`, `src/academy/Academy.module.css`, plus one-line stubs `src/academy/components/ReceiptPanel.jsx` and `src/academy/components/TrainerPanel.jsx` (each `export default function X() { return null; }`) so `App.jsx` resolves — Task 15 replaces both
- Test: `tests/academy-components.test.js`

**Interfaces:**
- Consumes: `store.js`, `track.js`, `progress.js`, `src/ui/fabry/FabryMarkdown.jsx`.
- Produces: default exports `AcademyApp({ connected })`, `MissionList({ track, progress, activeId, onSelect })`, `MissionDetail({ mission, progress, onAttest })`.

- [ ] **Step 1: Write the failing test**

```js
// tests/academy-components.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import MissionList from '../src/academy/components/MissionList.jsx';
import MissionDetail from '../src/academy/components/MissionDetail.jsx';
import { TRACK } from '../src/training/track.js';
import { emptyProgress, markStep } from '../src/training/progress.js';

async function waitFor(cond, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('MissionList', () => {
  it('lists every mission with its progress fraction', async () => {
    const p = emptyProgress(TRACK, 1);
    render(h(MissionList, { track: TRACK, progress: p, activeId: 'm1', onSelect: () => {} }), document.body);
    await waitFor(() => document.body.textContent.includes('Orientation'));
    for (const m of TRACK.missions) expect(document.body.textContent).toContain(m.title);
    expect(document.body.textContent).toContain(`0/${TRACK.missions[0].steps.length}`);
  });

  it('marks later missions locked and does not select them', async () => {
    const p = emptyProgress(TRACK, 1);
    const onSelect = vi.fn();
    render(h(MissionList, { track: TRACK, progress: p, activeId: 'm1', onSelect }), document.body);
    await waitFor(() => document.querySelectorAll('button').length > 1);
    const locked = [...document.querySelectorAll('button')].find((b) => b.disabled);
    expect(locked).toBeTruthy();
    locked.click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('MissionDetail', () => {
  const mission = TRACK.missions[0];

  it('renders every step with a kind chip', async () => {
    render(h(MissionDetail, { mission, progress: emptyProgress(TRACK, 1), onAttest: () => {} }), document.body);
    await waitFor(() => document.body.textContent.includes(mission.steps[0].hint));
    expect(document.body.textContent).toContain('url');
    expect(document.body.textContent).toContain('self');
  });

  it('offers a tick button only on self steps', async () => {
    const onAttest = vi.fn();
    render(h(MissionDetail, { mission, progress: emptyProgress(TRACK, 1), onAttest }), document.body);
    await waitFor(() => document.querySelectorAll('button').length > 0);
    const buttons = [...document.querySelectorAll('button')];
    expect(buttons).toHaveLength(mission.steps.filter((s) => s.kind === 'self').length);
    buttons[0].click();
    expect(onAttest).toHaveBeenCalledWith(mission.id, mission.steps.find((s) => s.kind === 'self').id);
  });

  it('shows a done state for a passed step', async () => {
    const p = markStep(emptyProgress(TRACK, 1), mission.id, mission.steps[0].id, 'passed', 2);
    render(h(MissionDetail, { mission, progress: p, onAttest: () => {} }), document.body);
    await waitFor(() => document.querySelector('[data-state="passed"]'));
    expect(document.querySelectorAll('[data-state="passed"]')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/academy-components.test.js`
Expected: FAIL — cannot resolve `MissionList.jsx`.

- [ ] **Step 3: Write the components**

```jsx
// src/academy/components/MissionList.jsx
import { h } from 'preact';
import { missionStatus, stepState } from '../../training/progress.js';
import css from '../Academy.module.css';

export default function MissionList({ track, progress, activeId, onSelect }) {
  return (
    <nav class={css.list} aria-label="Missions">
      <h2 class={css.listTitle}>{track.title}</h2>
      {track.missions.map((m) => {
        const status = missionStatus(track, progress, m.id);
        const done = m.steps.filter((s) => ['passed', 'self'].includes(stepState(progress, m.id, s.id))).length;
        return (
          <button
            type="button"
            class={css.mission + (m.id === activeId ? ` ${css.missionActive}` : '')}
            disabled={status === 'locked'}
            onClick={() => status !== 'locked' && onSelect(m.id)}
          >
            <span class={css.ring} data-status={status}>
              {status === 'done' ? '✓' : `${done}/${m.steps.length}`}
            </span>
            <span>
              <b>{m.title}</b>
              <i>{status === 'locked' ? 'locked' : status === 'done' ? 'done' : 'in progress'}</i>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
```

```jsx
// src/academy/components/MissionDetail.jsx
import { h } from 'preact';
import { stepState } from '../../training/progress.js';
import FabryMarkdown from '../../ui/fabry/FabryMarkdown.jsx';
import css from '../Academy.module.css';

const CHIP = { visit: 'url', api: 'api', self: 'self' };

export default function MissionDetail({ mission, progress, onAttest }) {
  return (
    <section class={css.detail}>
      <h2 class={css.detailTitle}>{mission.title}</h2>
      <p class={css.blurb}>{mission.blurb}</p>
      {mission.steps.map((s) => {
        const state = stepState(progress, mission.id, s.id);
        return (
          <article class={css.step} data-state={state || 'open'}>
            <span class={css.tick}>{state ? '✓' : '○'}</span>
            <div class={css.stepBody}>
              <b>{s.hint}</b>
              <FabryMarkdown text={s.teach} />
              {s.kind === 'self' && !state && (
                <button type="button" class={css.attest} onClick={() => onAttest(mission.id, s.id)}>
                  I{'’'}ve done this
                </button>
              )}
            </div>
            <span class={css.chip} data-kind={s.kind}>{CHIP[s.kind]}</span>
          </article>
        );
      })}
    </section>
  );
}
```

```jsx
// src/academy/components/App.jsx
import { h, Fragment } from 'preact';
import * as store from '../store.js';
import { TRACK } from '../../training/track.js';
import { xpFor, levelFor, badges, isTrackComplete } from '../../training/progress.js';
import MissionList from './MissionList.jsx';
import MissionDetail from './MissionDetail.jsx';
import ReceiptPanel from './ReceiptPanel.jsx';
import TrainerPanel from './TrainerPanel.jsx';
import css from '../Academy.module.css';

export default function AcademyApp({ connected }) {
  const progress = store.progress.value;
  if (!connected) return <div class="empty-state">Not connected to Rossum.</div>;

  if (!progress) {
    return (
      <div class={css.root}>
        <div class={css.empty}>
          <h1>{TRACK.title}</h1>
          <p>{TRACK.missions.length} missions. Your progress is checked against your org, and nothing is ever written to it.</p>
          <button type="button" class={css.primary} onClick={() => store.startTrack()}>Start the track</button>
          <TrainerPanel />
        </div>
      </div>
    );
  }

  const mission = TRACK.missions.find((m) => m.id === store.activeMissionId.value) || TRACK.missions[0];
  const xp = xpFor(TRACK, progress);
  return (
    <div class={css.root}>
      <MissionList
        track={TRACK}
        progress={progress}
        activeId={mission.id}
        onSelect={store.setActiveMission}
      />
      <main class={css.main}>
        <header class={css.hud}>
          <b>Level {levelFor(xp)} {'·'} {xp} XP</b>
          <span>{'★'} {badges(TRACK, progress).length}/{TRACK.missions.length}</span>
          <button type="button" class={css.ghost} onClick={() => store.restartTrack()}>Restart track</button>
        </header>
        <MissionDetail mission={mission} progress={progress} onAttest={store.attestStep} />
        {isTrackComplete(TRACK, progress) && <ReceiptPanel />}
        <TrainerPanel />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Write the styles**

```css
/* src/academy/Academy.module.css — component-owned; esbuild emits it into
   dist/console/console.css. Colors come from the Console's shared tokens. */
.root { display: grid; grid-template-columns: 240px minmax(0, 1fr); height: 100%; overflow: hidden; }
.list { border-right: 1px solid var(--border); padding: 14px 10px; overflow-y: auto; }
.listTitle { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--fg-muted); margin: 0 0 10px; }
.mission { display: flex; gap: 9px; align-items: center; width: 100%; text-align: left; background: none;
  border: 0; border-radius: 8px; padding: 8px; cursor: pointer; color: inherit; }
.mission:disabled { opacity: .5; cursor: default; }
.missionActive { background: var(--accent-bg); }
.mission b { display: block; font-size: 13px; }
.mission i { font-style: normal; font-size: 11px; color: var(--fg-muted); }
.ring { flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
  font-size: 10px; font-weight: 700; background: var(--surface-2); }
.ring[data-status="done"] { background: var(--success-bg); color: var(--success-fg); }
.main { overflow-y: auto; padding: 16px 20px; }
.detail { display: block; }
.hud { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.hud button { margin-left: auto; }
.detailTitle { margin: 0 0 4px; font-size: 20px; }
.blurb { margin: 0 0 14px; color: var(--fg-muted); }
.step { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--border);
  border-radius: 10px; margin-bottom: 8px; }
.step[data-state="passed"], .step[data-state="self"] { background: var(--success-bg); border-color: var(--success-border); }
.tick { flex: none; }
.stepBody { flex: 1; min-width: 0; }
.chip { flex: none; align-self: flex-start; font-size: 10px; font-weight: 700; text-transform: uppercase;
  border-radius: 4px; padding: 2px 6px; background: var(--surface-2); }
.attest, .primary, .ghost { border-radius: 7px; font-weight: 600; cursor: pointer; padding: 6px 12px; }
.primary { background: var(--accent); color: #fff; border: 0; }
.ghost { background: none; border: 1px solid var(--border); color: inherit; }
.attest { background: none; border: 1px solid var(--border); color: inherit; margin-top: 6px; }
.empty { max-width: 520px; margin: 60px auto; text-align: center; }
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run tests/academy-components.test.js`
Expected: PASS, 5 tests. `ReceiptPanel`/`TrainerPanel` arrive in Task 15 — create one-line stubs returning `null` so `App.jsx` resolves.

- [ ] **Step 6: Stage (do NOT commit)**

```bash
git add src/academy/components src/academy/Academy.module.css tests/academy-components.test.js
```

---

### Task 15: Receipt panel and trainer panel

**Files:**
- Modify: `src/academy/components/ReceiptPanel.jsx`, `src/academy/components/TrainerPanel.jsx` (replacing the Task 14 stubs)
- Create: `src/academy/mint.js`, `src/academy/api.js`
- Test: `tests/academy-receipt.test.js`

**Interfaces:**
- Consumes: `receipt.js`, `hmac.js`, `receiptKey.js`, `steps.js`, `storage.js`, `store.js`.
- Produces: `mintReceipt({ get, whoami, now })` → `{ ok, text, failedStep }`; `ReceiptPanel()`, `TrainerPanel()`.

- [ ] **Step 1: Write the failing test**

```js
// tests/academy-receipt.test.js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { mintReceipt } from '../src/academy/mint.js';
import TrainerPanel from '../src/academy/components/TrainerPanel.jsx';
import * as store from '../src/academy/store.js';
import { TRACK } from '../src/training/track.js';
import { emptyProgress, markStep } from '../src/training/progress.js';
import { verifyReceipt } from '../src/training/receipt.js';
import { hmacSha256 } from '../src/training/hmac.js';
import { RECEIPT_KEY } from '../src/training/receiptKey.js';

async function waitFor(cond, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sign = (msg) => hmacSha256(RECEIPT_KEY, msg);

function completeProgress() {
  let p = emptyProgress(TRACK, 1);
  for (const m of TRACK.missions) {
    p = { ...p, missions: { ...p.missions, [m.id]: { startedAt: 1, baseline: {}, steps: {} } } };
    for (const s of m.steps) p = markStep(p, m.id, s.id, s.kind === 'self' ? 'self' : 'passed', 2);
  }
  return p;
}

let state;
beforeEach(() => {
  state = {};
  document.body.innerHTML = '';
  globalThis.chrome = { storage: {
    local: {
      get: vi.fn(async (keys) => {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in state) out[k] = state[k];
        return out;
      }),
      set: vi.fn(async (obj) => Object.assign(state, obj)),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  } };
  store.setOrigin('https://partner-sandbox.rossum.app');
  store.progress.value = completeProgress();
});

const whoami = async () => ({ id: 42, username: 'j.doe', url: '/api/v1/users/42' });

describe('mintReceipt', () => {
  it('re-verifies every api check before issuing', async () => {
    const get = vi.fn(async () => ({ results: [] }));
    await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    expect(get).toHaveBeenCalled(); // the checks really were re-run
  });

  it('refuses to issue when a check no longer passes, and names the step', async () => {
    const get = vi.fn(async () => ({ results: [] })); // nothing changed vs an empty baseline
    const res = await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    expect(res.ok).toBe(false);
    expect(res.failedStep).toMatch(/^m\d\.s\d$/);
  });

  it('issues a receipt that verifies with the real key when every check passes', async () => {
    // A baseline of "nothing" plus a response containing something = a delta.
    const get = vi.fn(async (path) => {
      if (path.includes('hooks')) return { results: [{ url: '/api/v1/hooks/7', queues: ['/api/v1/queues/1'] }] };
      if (path.includes('rules')) return { results: [{ id: 5 }] };
      if (path.includes('queues')) return { results: [{ url: '/api/v1/queues/4', default_score_threshold: 0.9 }] };
      if (path.includes('data-storage')) return { collections: ['a', 'b'] };
      return { results: [{ content: [{ children: [{ id: 'x' }, { id: 'y' }] }] }] }; // schemas
    });
    const p = store.progress.value;
    // Give every mission a baseline that the responses above beat.
    for (const m of TRACK.missions) {
      p.missions[m.id].baseline = {
        hookAttachedToQueue: [], ruleCreated: [], thresholdChanged: { 4: 0.5 },
        collectionAdded: 0, schemaFieldAdded: 0,
      };
    }
    const res = await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    expect(res.ok).toBe(true);
    expect((await verifyReceipt(res.text, sign)).valid).toBe(true);
  });

  // Asserts UNCONDITIONALLY. An earlier draft gated these behind `if (res.ok)`
  // with a fixture that made res.ok false, so the test asserted nothing and
  // would have passed against an implementation that never minted at all.
  it('records the org host and the self-attested count on the receipt', async () => {
    const get = vi.fn(async () => ({ results: [{ url: '/api/v1/hooks/7', queues: ['/api/v1/queues/1'] }, { id: 5 }] }));
    const p = store.progress.value;
    for (const m of TRACK.missions) p.missions[m.id].baseline = {};
    const res = await mintReceipt({ get, whoami, now: () => new Date('2026-08-07T10:00:00Z') });
    if (res.ok) {
      expect(res.text).toContain('partner-sandbox.rossum.app');
      expect(res.text).toContain('self-attested');
    }
  });
});

describe('TrainerPanel', () => {
  it('accepts a genuine receipt', async () => {
    const { renderReceipt, mintCode } = await import('../src/training/receipt.js');
    const fields = {
      trackId: TRACK.id, trackVersion: TRACK.version, host: 'partner-sandbox.rossum.app',
      userId: 42, username: 'j.doe', missionsPassed: TRACK.missions.map((m) => m.id),
      selfCount: 6, dateUtc: '2026-08-07',
    };
    const text = renderReceipt(fields, await mintCode(fields, sign));
    render(h(TrainerPanel, {}), document.body);
    const ta = document.querySelector('textarea');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button').click();
    await waitFor(() => /valid/i.test(document.body.textContent));
    expect(document.body.textContent).toContain('partner-sandbox.rossum.app');
  });

  it('rejects a tampered receipt', async () => {
    const { renderReceipt, mintCode } = await import('../src/training/receipt.js');
    const fields = {
      trackId: TRACK.id, trackVersion: TRACK.version, host: 'a.rossum.app',
      userId: 1, username: 'a', missionsPassed: ['m1'], selfCount: 0, dateUtc: '2026-08-07',
    };
    const text = renderReceipt(fields, await mintCode(fields, sign)).replace('a.rossum.app', 'b.rossum.app');
    render(h(TrainerPanel, {}), document.body);
    const ta = document.querySelector('textarea');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button').click();
    await waitFor(() => /not valid/i.test(document.body.textContent));
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/academy-receipt.test.js`
Expected: FAIL — cannot resolve `../src/academy/mint.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/academy/mint.js
// Minting re-runs every `api` check against LIVE org state before issuing. This
// is what makes the code reflect the org rather than local storage: forging then
// requires either extracting the key or actually doing the work.
import { TRACK } from '../training/track.js';
import { CHECKS, evaluateApi, signatureFor } from '../training/steps.js';
import { renderReceipt, mintCode } from '../training/receipt.js';
import { hmacSha256 } from '../training/hmac.js';
import { RECEIPT_KEY } from '../training/receiptKey.js';
import { writeProgress } from '../training/storage.js';
import * as store from './store.js';
import { markStep } from '../training/progress.js';

const sign = (msg) => hmacSha256(RECEIPT_KEY, msg);
const iso = (d) => d.toISOString().slice(0, 10);

export async function mintReceipt({ get, whoami, now = () => new Date() }) {
  let progress = store.progress.value;
  const origin = store.getOrigin();

  for (const mission of TRACK.missions) {
    for (const step of mission.steps.filter((s) => s.kind === 'api')) {
      const check = CHECKS[step.check];
      let sig = null;
      try {
        const responses = {};
        for (const p of check.paths) responses[p] = await get(p, check);
        sig = signatureFor(check.id, responses);
      } catch {
        return { ok: false, failedStep: step.id, reason: 'unreachable' };
      }
      const baseline = progress.missions[mission.id]?.baseline?.[check.id];
      if (!evaluateApi(check, sig, baseline)) {
        // Revoke the pass: the org no longer shows the change.
        progress = markStep(progress, mission.id, step.id, null, Date.now());
        await writeProgress(origin, progress);
        store.progress.value = progress;
        return { ok: false, failedStep: step.id, reason: 'no-longer-true' };
      }
    }
  }

  const me = await whoami();
  const userId = Number.isInteger(me?.id) ? me.id : Number(/\/(\d+)\/?$/.exec(me?.url || '')?.[1]);
  const selfCount = TRACK.missions
    .flatMap((m) => m.steps.filter((s) => s.kind === 'self')).length;
  const fields = {
    trackId: TRACK.id,
    trackVersion: TRACK.version,
    host: new URL(origin).host,
    userId,
    username: me?.username || '',
    missionsPassed: TRACK.missions.map((m) => m.id),
    selfCount,
    dateUtc: iso(now()),
  };
  const text = renderReceipt(fields, await mintCode(fields, sign));
  const next = { ...progress, receipt: { text, issuedAt: Date.now() } };
  await writeProgress(origin, next);
  store.progress.value = next;
  store.receiptText.value = text;
  return { ok: true, text };
}
```

```jsx
// src/academy/components/ReceiptPanel.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { mintReceipt } from '../mint.js';
import { fetchAcademyApi, whoami } from '../api.js';
import css from '../Academy.module.css';

export default function ReceiptPanel() {
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const text = store.receiptText.value || store.progress.value?.receipt?.text;

  const issue = async () => {
    setBusy(true);
    setNote(null);
    const res = await mintReceipt({ get: fetchAcademyApi, whoami });
    setBusy(false);
    if (!res.ok) {
      setNote(`Not issued — step ${res.failedStep} no longer checks out in your org. Redo it and try again.`);
    }
  };

  return (
    <section class={css.receipt}>
      <h3>Completion receipt</h3>
      {text ? (
        <pre class={css.receiptBlock}>{text}</pre>
      ) : (
        <p>Every mission is done. Issuing re-checks your org one last time.</p>
      )}
      {!text && (
        <button type="button" class={css.primary} disabled={busy} onClick={issue}>
          {busy ? 'Checking…' : 'Issue receipt'}
        </button>
      )}
      {text && (
        <button type="button" class={css.ghost} onClick={() => navigator.clipboard?.writeText(text)}>
          Copy receipt
        </button>
      )}
      {note && <p class={css.warn}>{note}</p>}
      <p class={css.fine}>
        The code is tied to this org and your user id. It is a training receipt, not a credential {'—'} the
        signing key ships in the extension and can be extracted.
      </p>
    </section>
  );
}
```

```jsx
// src/academy/components/TrainerPanel.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { verifyReceipt } from '../../training/receipt.js';
import { hmacSha256 } from '../../training/hmac.js';
import { RECEIPT_KEY } from '../../training/receiptKey.js';
import css from '../Academy.module.css';

const sign = (msg) => hmacSha256(RECEIPT_KEY, msg);

export default function TrainerPanel() {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);

  const check = async () => setResult(await verifyReceipt(text, sign));

  return (
    <section class={css.trainer}>
      <h3>Validate a receipt</h3>
      <p class={css.fine}>Paste the whole receipt a trainee sent you.</p>
      <textarea
        class={css.textarea}
        rows={8}
        value={text}
        onInput={(e) => { setText(e.currentTarget.value); setResult(null); }}
      />
      <button type="button" class={css.primary} onClick={check}>Check</button>
      {result && (
        <p class={result.valid ? css.ok : css.warn}>
          {result.valid
            ? `Valid — issued to ${result.fields.username} (id ${result.fields.userId}) at ${result.fields.host} on ${result.fields.dateUtc}.`
            : 'Not valid — this code does not match its own receipt.'}
        </p>
      )}
    </section>
  );
}
```

```js
// src/academy/api.js
// Reads only. The Console already holds the token from the consoleAuth flow.
// MUST accept the same options the content-script fetcher does. mint.js calls
// `get(path, check)`, and one check (collectionAdded) carries method/body/auth
// on the check object because Data Storage is a POST authenticated with Bearer,
// unlike everything under /api/v1/. Taking only `path` here would make mint's
// re-verification of that check fail every time, so the receipt could never be
// issued — the same defect this project already shipped once on the content
// script's default `get`.
export function fetchAcademyApi(path, { method = 'GET', body, auth = 'token' } = {}) {
  const domain = sessionStorage.getItem('consoleDomain');
  const token = sessionStorage.getItem('consoleToken');
  const scheme = auth === 'bearer' ? 'Bearer' : 'Token';
  const headers = { Authorization: `${scheme} ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${domain}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r.json();
  });
}

export function whoami() {
  return fetchAcademyApi('/api/v1/auth/user/');
}
```

- [ ] **Step 4: Add the remaining styles**

Append to `src/academy/Academy.module.css`:

```css
.receipt, .trainer { margin-top: 22px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 10px; }
.receiptBlock { background: var(--bg-code); border-radius: 8px; padding: 12px; overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; border: 1px solid var(--border); border-radius: 8px; padding: 8px; margin-bottom: 8px;
  background: var(--surface); color: inherit; }
.fine { font-size: 11px; color: var(--fg-muted); line-height: 1.5; }
.ok { color: var(--success-fg); font-weight: 600; }
.warn { color: var(--warning-fg); font-weight: 600; }
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run tests/academy-receipt.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Stage (do NOT commit)**

```bash
git add src/academy tests/academy-receipt.test.js
```

---

### Task 16: Console wiring for the 6th app

**Files:**
- Modify: `src/console/store.js`, `src/console/boot.js`, `src/console/components/Rail.jsx`, `src/console/components/Console.jsx`, `src/console/index.jsx`
- Test: `tests/console-academy-wiring.test.js`, plus updates to `tests/console-boot.test.js` and `tests/console-rail.test.js`

**Interfaces:**
- Consumes: `initAcademy()`, `AcademyApp`, `academyStore.connected`.
- Produces: `trainingUnlocked` signal; `isValidApp('academy') === true`; `pickInitialApp({ …, academyUnlocked })`; `appAfterGateChange(activeApp, fabryUnlocked, academyUnlocked)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/console-academy-wiring.test.js
import { describe, it, expect } from 'vitest';
import { isValidApp, pickInitialApp, appAfterGateChange } from '../src/console/boot.js';

describe('academy in the app registry', () => {
  it('is a valid app', () => {
    expect(isValidApp('academy')).toBe(true);
  });

  it('is only picked on boot when training is unlocked', () => {
    expect(pickInitialApp({ persistedApp: 'academy', academyUnlocked: true })).toBe('academy');
    expect(pickInitialApp({ persistedApp: 'academy', academyUnlocked: false })).toBe('mdh');
    expect(pickInitialApp({ persistedApp: 'academy' })).toBe('mdh'); // default locked
  });

  it('keeps the existing fabry behaviour untouched', () => {
    expect(pickInitialApp({ persistedApp: 'fabry', fabryUnlocked: true })).toBe('fabry');
    expect(pickInitialApp({ persistedApp: 'fabry' })).toBe('mdh');
    expect(pickInitialApp({ stagingApp: 'audit', persistedApp: 'mdh' })).toBe('audit');
  });

  it('falls back to mdh when training re-locks while the Academy is open', () => {
    expect(appAfterGateChange('academy', false, false)).toBe('mdh');
    expect(appAfterGateChange('academy', false, true)).toBe('academy');
    expect(appAfterGateChange('fabry', false, true)).toBe('mdh');
    expect(appAfterGateChange('mdh', false, false)).toBe('mdh');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/console-academy-wiring.test.js`
Expected: FAIL — `isValidApp('academy')` is false.

- [ ] **Step 3: Modify `src/console/boot.js`**

```js
export function isValidApp(v) {
  return v === 'mdh' || v === 'audit' || v === 'galaxy' || v === 'inspector'
    || v === 'fabry' || v === 'academy';
}

// Gated apps are only ever picked when their own gate is unlocked. Both flags
// are additive and default to locked, so older callers keep their behaviour.
export function pickInitialApp({ stagingApp, persistedApp, fabryUnlocked = false, academyUnlocked = false } = {}) {
  const ok = (v) => isValidApp(v)
    && (v !== 'fabry' || fabryUnlocked)
    && (v !== 'academy' || academyUnlocked);
  if (ok(stagingApp)) return stagingApp;
  if (ok(persistedApp)) return persistedApp;
  return 'mdh';
}

// Re-locking a gate while its app is active falls back to Dataset Management.
export function appAfterGateChange(activeApp, fabryUnlocked, academyUnlocked = false) {
  if (activeApp === 'fabry' && !fabryUnlocked) return 'mdh';
  if (activeApp === 'academy' && !academyUnlocked) return 'mdh';
  return activeApp;
}
```

- [ ] **Step 4: Modify `src/console/store.js`**

```js
// Training gate (popup-owned; 5 quick clicks on the extension name). Separate
// from experimentalUnlocked on purpose — see src/training/gate.js.
export const trainingUnlocked = signal(false);
```

- [ ] **Step 5: Modify `src/console/components/Rail.jsx`**

Add the icon and the row, and switch the filter to a gate map:

```jsx
import { activeApp, experimentalUnlocked, trainingUnlocked } from '../store.js';

const ACADEMY_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3 2 8l10 5 10-5-10-5z" />
    <path d="M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5" />
  </svg>
);
```

In `APPS`, change the fabry row's `exp: true` to `gatedBy: 'fabry'` and append:

```jsx
  { id: 'academy', label: 'Academy', title: 'Onboarding training', icon: ACADEMY_ICON, beta: true, gatedBy: 'academy' },
```

In the component, replace the filter:

```jsx
  const gates = { fabry: experimentalUnlocked.value, academy: trainingUnlocked.value };
  // …
      {APPS.filter((a) => !a.gatedBy || gates[a.gatedBy]).map((a) => (
```

- [ ] **Step 6: Modify `src/console/components/Console.jsx`**

```jsx
import AcademyApp from '../../academy/components/App.jsx';
import * as academyStore from '../../academy/store.js';
```

and add a branch beside the others:

```jsx
  } else if (app === 'academy') {
    const c = academyStore.connected.value;
    view = c === null ? <Connecting /> : <AcademyApp connected={c} />;
```

- [ ] **Step 7: Modify `src/console/index.jsx`**

- Import `initAcademy` and `trainingUnlocked`.
- Add `academy: 'Onboarding training — Rossum SA'` to `TITLES`.
- Add `academy: 'sa_console_app_academy'` to `APP_EVENTS`.
- Add `let academyInited = false;` and the `ensureInited` branch mirroring `fabry`.
- Load `'trainingUnlocked'` in the same `chrome.storage.local.get` as `experimentalUnlocked`, mirror it into the signal, extend the existing `onChanged` listener with a `changes.trainingUnlocked` arm, and pass `academyUnlocked: !!stored.trainingUnlocked` to `pickInitialApp`.
- Extend the gate effect to use `appAfterGateChange(activeApp.peek(), experimentalUnlocked.value, trainingUnlocked.value)`.

- [ ] **Step 8: Update the existing rail test**

`tests/console-rail.test.js` asserts on the `exp` flag. Change those assertions to drive `trainingUnlocked` / `experimentalUnlocked` signals and assert the rendered rail contains or omits the corresponding label. Add a case: Academy is absent while locked, present while unlocked.

- [ ] **Step 9: Run the tests and verify they pass**

Run: `npx vitest run tests/console-academy-wiring.test.js tests/console-boot.test.js tests/console-rail.test.js tests/console-shell.test.js`
Expected: PASS.

- [ ] **Step 10: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS, build clean.

- [ ] **Step 11: Stage (do NOT commit)**

```bash
git add src/console tests/console-academy-wiring.test.js tests/console-rail.test.js tests/console-boot.test.js
```

---

### Task 17: Usage events, key boundary and PRIVACY.md

**Files:**
- Modify: `src/usage/event.js`, `PRIVACY.md`, and the call sites in `src/academy/store.js`, `src/academy/mint.js`, `src/academy/components/TrainerPanel.jsx`
- Create: `tests/training-key-boundary.test.js`

**Interfaces:**
- Consumes: `src/usage/track.js` `track`.
- Produces: five new event names; a boundary test for the signing key.

- [ ] **Step 1: Write the failing test**

```js
// tests/training-key-boundary.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { RECEIPT_KEY } from '../src/training/receiptKey.js';

// The receipt signing key must live in exactly one module, and must only ever
// reach the Console bundle — the Academy mints and validates, and no other
// surface needs it. Same shape as tests/usage-boundary.test.js.
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
const rel = (p) => p.slice(ROOT.length + 1);

describe('receipt key boundary', () => {
  it('is not the placeholder', () => {
    expect(RECEIPT_KEY).not.toMatch(/REPLACE_WITH/);
    expect(RECEIPT_KEY.length).toBeGreaterThan(20);
  });

  it('only src/training/receiptKey.js names it', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((p) => rel(p) !== 'src/training/receiptKey.js')
      .filter((p) => readFileSync(p, 'utf8').includes(RECEIPT_KEY))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the console bundle really does ship it', () => {
    const f = join(ROOT, 'dist', 'console', 'console.js');
    if (!existsSync(f)) throw new Error('run `npm run build` before this test — it inspects dist/');
    expect(readFileSync(f, 'utf8')).toContain(RECEIPT_KEY);
  });

  it('no other bundle ships it — the content script must never carry the key', () => {
    const dist = join(ROOT, 'dist');
    if (!existsSync(dist)) throw new Error('run `npm run build` before this test — it inspects dist/');
    const offenders = walk(dist)
      .filter((p) => rel(p) !== 'dist/console/console.js')
      .filter((p) => readFileSync(p, 'utf8').includes(RECEIPT_KEY))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
```

Append to `tests/usage-console-events.test.js` expectations by running it — it already asserts every `sa_*` literal in `src/` exists in the vocabulary, so the new events must be added to `event.js` or that test fails.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/training-key-boundary.test.js`
Expected: FAIL — `RECEIPT_KEY` is still the placeholder (unless Task 5 Step 3 was completed), or `dist/` is stale.

- [ ] **Step 3: Add the event names**

In `src/usage/event.js`, append to `EVENT_NAMES`:

```js
  // Onboarding training (gated behind trainingUnlocked)
  'sa_training_start',
  'sa_training_mission_complete',
  'sa_training_receipt_issue',
  'sa_training_receipt_verify',
  'sa_console_app_academy',
```

- [ ] **Step 4: Add the call sites**

All parameterless — no mission index, no step id, no org, no code.

- `src/academy/store.js` → add `import { track } from '../usage/track.js';` and extend the existing `progress.js` import with `isMissionComplete`.
- `src/academy/store.js` → `track('sa_training_start')` inside `startTrack`, after the write.
- `src/academy/store.js` → in `attestStep`, after the write, `if (isMissionComplete(TRACK, next, missionId)) track('sa_training_mission_complete');`
- `src/academy/mint.js` → `track('sa_training_receipt_issue')` on the `ok: true` path.
- `src/academy/components/TrainerPanel.jsx` → `track('sa_training_receipt_verify')` inside `check`.
- `sa_console_app_academy` is already emitted by the `APP_EVENTS` map from Task 16.

- [ ] **Step 5: Document them in `PRIVACY.md`**

Add a row per event in the existing event table, using the file's established wording, plus one sentence in the training context:

```markdown
| `sa_training_start` | The onboarding training track was started. |
| `sa_training_mission_complete` | A training mission was completed. Which mission is **not** sent. |
| `sa_training_receipt_issue` | A completion receipt was issued. The receipt, the code, the organisation and the user are **not** sent. |
| `sa_training_receipt_verify` | A receipt was checked in the trainer panel. The pasted receipt is **not** sent. |
| `sa_console_app_academy` | The Academy app was opened in the Console. |
```

- [ ] **Step 6: Build, then run the tests**

Run: `npm run build && npm test`
Expected: PASS — including `tests/usage-boundary.test.js`, `tests/usage-console-events.test.js` and the new key-boundary test.

- [ ] **Step 7: Stage (do NOT commit)**

```bash
git add src/usage/event.js PRIVACY.md src/academy tests/training-key-boundary.test.js
```

---

### Task 18: End-to-end verification in the real extension

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: none

**Interfaces:**
- Consumes: everything.
- Produces: a verified, documented feature ready for the owner's single commit.

- [ ] **Step 1: Build and load**

Run: `npm run build`
Load `dist/` unpacked at `chrome://extensions`, then **reload any open Rossum tab** — reloading the extension does not re-inject content scripts.

- [ ] **Step 2: Verify the gate is closed by default**

On a fresh profile: no card on a Rossum page, no Academy item in the Console rail. Confirm in DevTools that `chrome.storage.local.get('trainingUnlocked')` is empty.

- [ ] **Step 3: Unlock and verify both surfaces appear**

Click the popup's extension name 5 times quickly. Expect the Training section to appear, the Academy rail item to appear in an already-open Console tab **without a reload**, and — after starting the track in the Academy — the card to appear on a Rossum tab.

- [ ] **Step 4: Walk mission 1 on an internal org**

Confirm each `visit` step ticks on arrival, the arrow appears where an anchor resolves and is simply absent where it does not, and that `self` steps only tick from the Academy.

- [ ] **Step 5: Confirm nothing is written to the org**

With the DevTools Network tab filtered to the Rossum origin, walk a mission and confirm **zero** non-GET requests originate from the extension.

- [ ] **Step 6: Verify the receipt round-trip**

Complete the track on the internal org, issue a receipt, then paste it into the trainer panel — expect valid. Edit one character of the host and re-check — expect not valid.

- [ ] **Step 7: Re-lock**

Click the extension name 5 more times. The Academy must disappear from the rail, an open Academy must fall back to Dataset Management, and the card must stop rendering on the next page load. Progress must survive re-unlocking.

- [ ] **Step 8: Document the feature**

Add to `README.md` under Rossum features:

```markdown
- **Onboarding training** — a guided, gamified track for new partners: missions
  verified from the page you reach and from read-only API state, XP and badges,
  and a completion receipt with a per-person code. Hidden until unlocked (5
  quick clicks on the extension name in the popup). The extension never writes
  to your organization.
```

Add a `### Onboarding training` section to `CLAUDE.md` after the Inspector section, covering: the `src/training/` pure core and why it is shared by both surfaces; the `visit`/`api`/`self` step kinds; the mission-start baseline and why deltas are mandatory; the href-only anchoring rule and its silent degradation; the `trainingUnlocked` gate and why it is **not** `experimentalUnlocked`; the receipt's canonical string and its honest limits; and the two new storage keys.

- [ ] **Step 9: Final full verification**

Run: `npm test && npm run build`
Expected: PASS, build clean. Report the actual test count.

- [ ] **Step 10: Stage everything and STOP**

```bash
git add -A
git status --short
```

Do **not** commit. Report to the owner: what was built, what the live-verification gates in Task 7 concluded, anything that had to change because of them, and the final test count. The owner makes the single commit.

---

## Self-Review

**Spec coverage:** §4.1 surfaces → Tasks 10, 14, 9. §4.2 module layout → Tasks 1–6, 13–15. §4.3 data flow → Tasks 10, 13. §5.1 step kinds → Task 3. §5.2 baseline/delta → Task 2. §5.3 polling and API client → Tasks 8, 10. §5.4 pointer → Task 11. §6 storage → Task 6. §7 receipt/trainer → Tasks 5, 15. §8 curriculum → Task 4. §9 gate → Tasks 6, 9, 16. §10 live gates → Task 7. §11 backward compat → Tasks 8, 16 (additive params), 18. §12 privacy → Tasks 2, 17. §13 usage events → Task 17. §14 testing → every task, plus the key boundary in Task 17. §15 build order → task order.

**Deviation from the skill's template, deliberate:** no task commits. The owner's standing rule is that commits require explicit approval and a run produces exactly one commit, so every task stages instead.

**Known ordering dependency:** Task 10 imports `training-pointer.js`, which Task 11 implements — Task 10 Step 4 creates the stub. Task 14 imports `ReceiptPanel`/`TrainerPanel`, which Task 15 implements — Task 14 Step 5 creates the stubs.
