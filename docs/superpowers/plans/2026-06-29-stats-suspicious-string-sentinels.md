# Stats tab — suspicious string-sentinel detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect placeholder string "sentinels" (e.g. the text `"null"`, `"N/A"`, `"-"`) in the MDH Stats tab, surface them in a dedicated "Suspicious Values" section, and fold them into the health score's emptiness component.

**Architecture:** Add one new check (`sentinels`) to the existing fixed `STATS_CHECKS` list. A `$facet`-per-field aggregation pipeline finds, per field, the count of each normalized (lowercased + trimmed) sentinel token among string values. Registering the check in `STATS_CHECKS` + `buildAllPipelines` automatically wires it into the foreground panel, the background prefetch, and (via `updateStatsSummary`) the tab-bar warning dot. The health-score penalty is a backward-compatible 7th optional parameter on `computeHealthScore`.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE bundle), Vitest. MongoDB aggregation (Rossum Data Storage API).

## Global Constraints

- **No git commits during this run.** Per the user's standing preference, do NOT `git commit` or branch. Each task ends by running the test suite green instead of committing. Stay on `master`.
- **Backward compatibility is mandatory.** Existing 6-arg `computeHealthScore` calls/tests, existing `transformStatsResults` per-key assertions, and the five required `updateStatsSummary` inputs must keep producing identical results. New inputs are trailing/optional.
- **No customer-data leakage.** Any live-org verification must not surface real customer field values or names in transcripts. Use generic example field names (`vendor`, `status`) in code/tests/docs.
- **JSX unicode rule** (from `CLAUDE.md`): `\uXXXX` does NOT work in JSX raw text or attributes — wrap glyphs in a JS expression (`{'×'}`) or paste the literal character. Applies to `×` (`×`), `·` (`·`), `—` (`—`).
- **Sentinel set (normalized, lowercase + trimmed):** `null, none, nan, undefined, nil, n/a, na, tbd, unknown, -, --, .` — exactly these 12 tokens, no more.
- Test runner: single file `npx vitest run tests/<file>.test.js`; full suite `npm test`. Build: `npm run build`.

---

### Task 1: `sentinels` aggregation check + registration

**Files:**
- Modify: `src/mdh/statsPipelines.js` (add constant + builder; register in `STATS_CHECKS` and `buildAllPipelines`)
- Test: `tests/mdh-pipelines.test.js` (add cases; update the existing "all 11 pipeline types" case)

**Interfaces:**
- Produces:
  - `export const SENTINEL_STRINGS` — `string[]` of 12 normalized tokens.
  - `export function buildSentinelStringsPipeline(fields: string[])` — returns a 2-stage pipeline `[fieldsOnly(fields), { $facet: {...} }]`; each facet sub-pipeline is keyed by `encKey(field)`.
  - `STATS_CHECKS` now includes `'sentinels'`.
  - `buildAllPipelines(fields).sentinels` is the sentinel pipeline.
- Consumes: existing `encKey`, `fieldsOnly` (module-private) from this file.

- [ ] **Step 1: Add the failing tests**

In `tests/mdh-pipelines.test.js`, extend the top import to include the new exports:

```js
import {
  // ...existing imports...
  buildAllPipelines,
  buildSentinelStringsPipeline,
  SENTINEL_STRINGS,
  STATS_CHECKS,
} from '../src/mdh/statsPipelines.js';
```

Add these cases inside the `describe('pipeline builders', ...)` block (which already defines `const fields = ['name', 'address.city', 'count'];`):

```js
it('SENTINEL_STRINGS is the broad placeholder set in normalized form', () => {
  expect(SENTINEL_STRINGS).toEqual(
    expect.arrayContaining([
      'null', 'none', 'nan', 'undefined', 'nil',
      'n/a', 'na', 'tbd', 'unknown', '-', '--', '.',
    ]),
  );
  expect(SENTINEL_STRINGS).toHaveLength(12);
  // every token is already lowercase + trimmed
  for (const s of SENTINEL_STRINGS) expect(s).toBe(s.toLowerCase().trim());
});

it('buildSentinelStringsPipeline facets per field and matches normalized sentinels', () => {
  const p = buildSentinelStringsPipeline(fields);
  expect(p).toHaveLength(2);
  expect(p[0]).toHaveProperty('$project');
  expect(p[1]).toHaveProperty('$facet');
  expect(p[1].$facet).toHaveProperty('name');
  expect(p[1].$facet).toHaveProperty('address__DOT__city');

  const stages = p[1].$facet.name;
  // 1) string-type guard
  expect(stages[0].$match).toEqual({ $expr: { $eq: [{ $type: '$name' }, 'string'] } });
  // 2) normalize (lowercase + trim)
  const proj = stages.find((s) => s.$project && s.$project.__n);
  expect(proj.$project.__n).toEqual({ $toLower: { $trim: { input: '$name' } } });
  // 3) keep only sentinel tokens
  const inMatch = stages.find((s) => s.$match && s.$match.__n);
  expect(inMatch.$match.__n).toEqual({ $in: SENTINEL_STRINGS });
  // 4) group by normalized token, sorted by count desc
  const group = stages.find((s) => s.$group);
  expect(group.$group._id).toBe('$__n');
  expect(group.$group.count).toEqual({ $sum: 1 });
});

it('STATS_CHECKS includes sentinels', () => {
  expect(STATS_CHECKS).toContain('sentinels');
});
```

Update the existing `buildAllPipelines` case (currently "returns all 11 pipeline types") to expect 12 keys including `sentinels`:

```js
it('buildAllPipelines returns all 12 pipeline types', () => {
  const all = buildAllPipelines(fields);
  expect(Object.keys(all).sort()).toEqual([
    'cardinality', 'coverage', 'dates', 'distribution', 'docSize',
    'empties', 'numeric', 'schema', 'sentinels', 'storage', 'strings', 'types',
  ]);
  for (const pipeline of Object.values(all)) {
    expect(Array.isArray(pipeline)).toBe(true);
    expect(pipeline.length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mdh-pipelines.test.js`
Expected: FAIL — `buildSentinelStringsPipeline`/`SENTINEL_STRINGS`/`STATS_CHECKS` import is `undefined`, and the "12 pipeline types" case fails on the old 11-key set.

- [ ] **Step 3: Implement the constant and builder**

In `src/mdh/statsPipelines.js`, add the constant just below the existing `MAX_FIELDS` line (top of file):

```js
// Normalized (lowercase, whitespace-trimmed) placeholder tokens that masquerade
// as real string data. Single source of truth for sentinel detection.
export const SENTINEL_STRINGS = [
  'null', 'none', 'nan', 'undefined', 'nil',
  'n/a', 'na', 'tbd', 'unknown', '-', '--', '.',
];
```

Add the builder near the other `$facet` builders (e.g. right after `buildStringAnalysisPipeline`):

```js
export function buildSentinelStringsPipeline(fields) {
  const facet = {};
  for (const f of fields) {
    facet[encKey(f)] = [
      { $match: { $expr: { $eq: [{ $type: `$${f}` }, 'string'] } } },
      { $project: { __n: { $toLower: { $trim: { input: `$${f}` } } } } },
      { $match: { __n: { $in: SENTINEL_STRINGS } } },
      { $group: { _id: '$__n', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];
  }
  return [fieldsOnly(fields), { $facet: facet }];
}
```

- [ ] **Step 4: Register the check**

In the same file, add `'sentinels'` to `STATS_CHECKS`:

```js
export const STATS_CHECKS = [
  'coverage', 'empties', 'types', 'distribution',
  'cardinality', 'strings', 'numeric', 'dates', 'schema',
  'storage', 'docSize', 'sentinels',
];
```

And add it to `buildAllPipelines` (alongside the others, before the closing brace):

```js
    sentinels: buildSentinelStringsPipeline(fields),
```

- [ ] **Step 5: Run the file's tests to verify they pass**

Run: `npx vitest run tests/mdh-pipelines.test.js`
Expected: PASS (all pipeline-builder cases, including the updated 12-types case).

- [ ] **Step 6: Run the full suite (no commit)**

Run: `npm test`
Expected: PASS — no other test couples to the check count. (If a green run, the task is done; do not commit.)

---

### Task 2: `transformSentinels` + `transformStatsResults` key

**Files:**
- Modify: `src/mdh/statsSummary.js` (add `transformSentinels`; add `sentinels` key to `transformStatsResults`)
- Test: `tests/mdh-stats-summary.test.js` (add cases to the existing `describe('transformStatsResults', ...)` block)

**Interfaces:**
- Consumes: `SENTINEL_STRINGS` is NOT needed here (matching happens server-side); uses `encKey` (already imported in the test) and the raw facet result shape `{ result: [{ <encKey(field)>: [{ _id, count }] }] }`.
- Produces:
  - `transformStatsResults(rawCache, fields).sentinels` — `Array<{ field: string, total: number, values: Array<{ value: string, count: number }> }>` filtered to `total > 0`, or `null` when `rawCache.sentinels` is absent.
  - `transformSentinels` stays module-private (tested via `transformStatsResults`, like the other transforms).

- [ ] **Step 1: Add the failing tests**

In `tests/mdh-stats-summary.test.js`, inside `describe('transformStatsResults', ...)` (which already defines `const fields = ['name', 'age'];` — use explicit field lists per case):

```js
it('transformSentinels rolls up buckets per field and filters clean fields', () => {
  const raw = {
    sentinels: {
      result: [{
        [encKey('vendor')]: [{ _id: 'null', count: 1204 }],
        [encKey('status')]: [{ _id: 'n/a', count: 89 }, { _id: 'none', count: 12 }],
        [encKey('clean')]: [],
      }],
    },
  };
  const out = transformStatsResults(raw, ['vendor', 'status', 'clean']);
  expect(out.sentinels).toEqual([
    { field: 'vendor', total: 1204, values: [{ value: 'null', count: 1204 }] },
    { field: 'status', total: 101, values: [{ value: 'n/a', count: 89 }, { value: 'none', count: 12 }] },
  ]);
});

it('transformStatsResults.sentinels is null when its raw input is missing', () => {
  const raw = {
    coverage: { result: [{ _total: 10, [`f_${encKey('name')}`]: 10, [`f_${encKey('age')}`]: 10 }] },
    empties: { result: [{}] },
    types: { result: [{}] },
    strings: { result: [{}] },
    schema: { result: [] },
    // no sentinels key
  };
  const out = transformStatsResults(raw, fields);
  expect(out.sentinels).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mdh-stats-summary.test.js`
Expected: FAIL — `out.sentinels` is `undefined` (key not yet added).

- [ ] **Step 3: Implement `transformSentinels` and add the key**

In `src/mdh/statsSummary.js`, add the function next to the other `transform*` helpers:

```js
function transformSentinels(raw, fields) {
  const r = raw.result?.[0] || {};
  return fields
    .map((f) => {
      const buckets = r[encKey(f)] || [];
      const values = buckets.map((b) => ({ value: b._id, count: b.count }));
      const total = values.reduce((s, v) => s + v.count, 0);
      return { field: f, total, values };
    })
    .filter((x) => x.total > 0);
}
```

Add the sixth key to the object returned by `transformStatsResults` (after `schemaShapes`):

```js
    sentinels: rawCache.sentinels ? transformSentinels(rawCache.sentinels, fields) : null,
```

- [ ] **Step 4: Run the file's tests to verify they pass**

Run: `npx vitest run tests/mdh-stats-summary.test.js`
Expected: PASS — including the existing `transformStatsResults` cases (they assert individual keys, never the whole object, so adding a key is safe).

- [ ] **Step 5: Run the full suite (no commit)**

Run: `npm test`
Expected: PASS.

---

### Task 3: Health-score penalty (`computeHealthScore`)

**Files:**
- Modify: `src/mdh/statsSummary.js` (`computeHealthScore` emptiness component + signature)
- Test: `tests/mdh-stats-summary.test.js` (add cases to the existing `describe('computeHealthScore', ...)` block)

**Interfaces:**
- Produces: `computeHealthScore(coverage, empties, types, strings, schemaShapes, fields, sentinels = null)` — `sentinels` is the array from Task 2 (or `null`/`[]`). When `null`/`[]`, the returned score is identical to the pre-feature 6-arg result.
- Consumes: `transformSentinels` output shape `{ field, total, values }` (only `.field` is read here).

- [ ] **Step 1: Add the failing tests**

In `tests/mdh-stats-summary.test.js`, inside `describe('computeHealthScore', ...)` (which defines `const fields = ['a','b','c','d'];` and `const perfectCoverage = ...`):

```js
it('penalizes sentinel-string fields like empties', () => {
  // 1 of 4 fields has sentinel strings, none empty → emptinessScore = 75
  // score = 100*0.25 + 100*0.20 + 75*0.15 + 100*0.20 + 100*0.20 = 96.25 → 96
  const sentinels = [{ field: 'a', total: 5, values: [{ value: 'null', count: 5 }] }];
  expect(computeHealthScore(perfectCoverage, [], [], [], [{ fieldCount: 4 }], fields, sentinels)).toBe(96);
});

it('counts a field with both empties and sentinels only once', () => {
  const empties = [{ field: 'a', nullCount: 1, missingCount: 0, emptyCount: 0 }];
  const sentinels = [{ field: 'a', total: 5, values: [{ value: 'null', count: 5 }] }];
  // still only field 'a' affected → emptinessScore = 75 → 96
  expect(computeHealthScore(perfectCoverage, empties, [], [], [{ fieldCount: 4 }], fields, sentinels)).toBe(96);
});

it('omitting sentinels reproduces the pre-feature score (backward compat)', () => {
  const empties = [{ field: 'a', nullCount: 5, missingCount: 0, emptyCount: 0 }];
  const withNull = computeHealthScore(perfectCoverage, empties, [], [], [{ fieldCount: 4 }], fields, null);
  const sixArg = computeHealthScore(perfectCoverage, empties, [], [], [{ fieldCount: 4 }], fields);
  expect(withNull).toBe(sixArg);
  expect(sixArg).toBe(96);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mdh-stats-summary.test.js -t "sentinel"`
Expected: FAIL — the two sentinel-penalty cases return 100 (no penalty applied yet). The backward-compat case passes already but is harmless.

- [ ] **Step 3: Implement the union-based emptiness component**

In `src/mdh/statsSummary.js`, change the `computeHealthScore` signature to add the trailing optional param, and replace the emptiness block. Current:

```js
export function computeHealthScore(coverage, empties, types, strings, schemaShapes, fields) {
  if (!coverage || !fields.length) return null;
  // ...
  // Emptiness: ratio of fields with no empty/null/missing issues (0–100)
  const emptyFieldCount = empties ? empties.length : 0;
  const emptinessScore = ((fields.length - emptyFieldCount) / fields.length) * 100;
```

Replace with:

```js
export function computeHealthScore(coverage, empties, types, strings, schemaShapes, fields, sentinels = null) {
  if (!coverage || !fields.length) return null;
  // ...
  // Emptiness: ratio of fields with no empty/null/missing/sentinel-string issues (0–100).
  // A field counts as "unclean" if it appears in empties OR carries sentinel strings.
  const affected = new Set();
  for (const e of (empties || [])) affected.add(e.field);
  for (const s of (sentinels || [])) affected.add(s.field);
  const emptinessScore = ((fields.length - affected.size) / fields.length) * 100;
```

(Leave the rest of the function — coverage, type, whitespace, schema components and the weighted sum — unchanged.)

- [ ] **Step 4: Run the file's tests to verify they pass**

Run: `npx vitest run tests/mdh-stats-summary.test.js`
Expected: PASS — including the existing `'penalizes empties per field'` case (empties has one entry per field, so `affected.size === empties.length` when `sentinels` is absent).

- [ ] **Step 5: Run the full suite (no commit)**

Run: `npm test`
Expected: PASS.

---

### Task 4: `updateStatsSummary` reads optional sentinel cache

**Files:**
- Modify: `src/mdh/statsSummary.js` (`updateStatsSummary`)
- Test: `tests/mdh-stats-summary.test.js` (add cases to the existing `describe('updateStatsSummary', ...)` block)

**Interfaces:**
- Consumes: cache key `stats_sentinels` (raw facet result); `transformStatsResults` (Task 2); `computeHealthScore` 7th param (Task 3).
- Produces: `statsSummary` signal value reflects the sentinel penalty when `stats_sentinels` is cached; absence of that key leaves behavior identical to before. The five existing inputs stay strictly required.

- [ ] **Step 1: Add the failing tests**

In `tests/mdh-stats-summary.test.js`, inside `describe('updateStatsSummary', ...)` (which has `beforeEach` clearing the cache + signal, and the `seedCleanCollection` helper that seeds the five required keys but NOT `stats_sentinels`):

```js
it('applies the sentinel penalty when stats_sentinels is seeded', () => {
  const col = 'col_sent';
  cache.set(col, 'statsFields', ['name', 'age']);
  cache.set(col, 'stats_coverage', {
    result: [{ _total: 100, [`f_${encKey('name')}`]: 100, [`f_${encKey('age')}`]: 100 }],
  });
  cache.set(col, 'stats_empties', { result: [{}] });
  cache.set(col, 'stats_types', { result: [{}] });
  cache.set(col, 'stats_strings', { result: [{}] });
  cache.set(col, 'stats_schema', { result: [{ _id: 2, count: 100, sampleFields: ['name', 'age'] }] });
  // "age" is 100 % the literal string "null" → counts as present in coverage,
  // but is flagged as a sentinel field.
  cache.set(col, 'stats_sentinels', { result: [{ [encKey('age')]: [{ _id: 'null', count: 100 }] }] });
  updateStatsSummary(col);
  // avgCoverage=100, emptinessScore=(2-1)/2*100=50, typeScore=100, wsScore=100, schemaScore=100
  // score = 100*0.25 + 100*0.20 + 50*0.15 + 100*0.20 + 100*0.20 = 92.5 → 93
  expect(statsSummary.value).toEqual({ collection: col, health: 93, label: 'Excellent' });
});

it('leaves the summary unchanged when stats_sentinels is absent (backward compat)', () => {
  seedCleanCollection('col1'); // no stats_sentinels
  updateStatsSummary('col1');
  expect(statsSummary.value).toEqual({ collection: 'col1', health: 100, label: 'Excellent' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mdh-stats-summary.test.js -t "sentinel penalty"`
Expected: FAIL — without reading `stats_sentinels`, the penalized case returns health 100, not 93.

- [ ] **Step 3: Implement the optional cache read + pass-through**

In `src/mdh/statsSummary.js`, update `updateStatsSummary`. Add the optional cache read to `rawCache`:

```js
  const rawCache = {
    coverage: cache.get(collection, 'stats_coverage'),
    empties: cache.get(collection, 'stats_empties'),
    types: cache.get(collection, 'stats_types'),
    strings: cache.get(collection, 'stats_strings'),
    schema: cache.get(collection, 'stats_schema'),
    sentinels: cache.get(collection, 'stats_sentinels'), // optional — penalty only when present
  };
```

Keep the existing required-input guard exactly as-is (it checks `t.coverage/empties/types/strings/schemaShapes === null` — do NOT add `sentinels` to it). Then pass `t.sentinels` as the 7th argument:

```js
  const health = computeHealthScore(
    t.coverage, t.empties, t.types, t.strings, t.schemaShapes, fields, t.sentinels,
  );
```

- [ ] **Step 4: Run the file's tests to verify they pass**

Run: `npx vitest run tests/mdh-stats-summary.test.js`
Expected: PASS — including the pre-existing clean/dirty/required-missing cases (unchanged: `seedCleanCollection` omits `stats_sentinels` → `t.sentinels` is `null` → no penalty).

- [ ] **Step 5: Run the full suite (no commit)**

Run: `npm test`
Expected: PASS. This completes the data/scoring layer; `prefetch.js` needs NO change (it loops `STATS_CHECKS` and calls `updateStatsSummary`, both already updated).

---

### Task 5: "Suspicious Values" section in the Stats panel + CSS

**Files:**
- Modify: `src/mdh/components/StatsPanel.jsx` (state, reset, result handler, `SECTION_ORDER`, live health arg, new section JSX)
- Modify: `src/console/console.css` (new `.stats-sentinel-*` classes)
- Verify: `npm run build` (esbuild) + `npm test` (suite stays green) + manual/browser check

**Interfaces:**
- Consumes: `transformStatsResults({ sentinels: res }, fields).sentinels` (Task 2); `computeHealthScore(..., sentinels)` (Task 3); existing `Section`, `FieldName`, `canShow`, `statuses`, `STATS_CHECKS`.
- Produces: rendered section; no new exports.

This task has no unit test (the panel is not unit-tested in this repo — its data layer is covered by Tasks 1–4). The gate is a clean build, a green suite, and a manual render check.

- [ ] **Step 1: Add the `sentinels` state and reset it**

In `src/mdh/components/StatsPanel.jsx`, add the state declaration next to the other `useState` lines (near `const [schemaShapes, setSchemaShapes] = useState(null);`):

```jsx
  const [sentinels, setSentinels] = useState(null);
```

In the run-reset block (where `setSchemaShapes(null);` etc. are called at the start of the `useEffect`), add:

```jsx
    setSentinels(null);
```

- [ ] **Step 2: Add the result handler**

In the `resultHandlers` object, add a `sentinels` entry (mirroring the other health-input handlers that route through `transformStatsResults`):

```jsx
        sentinels: (res) => setSentinels(transformStatsResults({ sentinels: res }, discoveredFields).sentinels),
```

- [ ] **Step 3: Register the section in `SECTION_ORDER` and pass sentinels to live health**

Add `'sentinels'` to `SECTION_ORDER` immediately after `'coverage'`:

```jsx
  const SECTION_ORDER = ['overview', 'distribution', 'coverage', 'sentinels', 'schema', 'cardinality', 'strings', 'numeric', 'dates'];
```

In the Overview block where live health is computed, add `sentinels` as the 7th argument:

```jsx
          const health = computeHealthScore(coverage, empties, types, stringAnalysis, schemaShapes, fields, sentinels);
```

- [ ] **Step 4: Add the "Suspicious Values" section JSX**

Insert directly AFTER the Field Quality `Section` block closes (after the `coverage && canShow('coverage')` block, before the `{/* Schema Consistency */}` comment):

```jsx
        {/* Suspicious Values (sentinel placeholder strings) */}
        {sentinels && canShow('sentinels') && (
          <Section title="Suspicious Values" status={statuses.sentinels}>
            <div class="stats-note">
              Fields containing placeholder text that masquerades as data {'—'} values
              like "null", "N/A", or "-" (matched case-insensitively, whitespace-trimmed).
              These pass the coverage check because they are real strings, but they usually
              mean the value is actually missing.
            </div>
            {sentinels.length === 0 ? (
              <div class="stats-ok">No suspicious placeholder strings found</div>
            ) : (
              <div class="stats-sentinel-list">
                {sentinels.map((s) => (
                  <div class="stats-sentinel-row">
                    <span class="stats-sentinel-field"><FieldName path={s.field} /></span>
                    <span class="stats-sentinel-tokens">
                      {s.values.map((v) => (
                        <span class="stats-sentinel-token">
                          <span class="stats-dist-special">{v.value}</span>
                          <span class="stats-sentinel-count">{'×'}{v.count.toLocaleString()}</span>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}
```

- [ ] **Step 5: Add the CSS**

In `src/console/console.css`, add near the other `.stats-dist-*` rules:

```css
.stats-sentinel-list {
  display: flex; flex-direction: column; gap: 6px;
}
.stats-sentinel-row {
  display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
}
.stats-sentinel-field {
  min-width: 140px; flex-shrink: 0;
}
.stats-sentinel-tokens {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline;
}
.stats-sentinel-token {
  display: inline-flex; align-items: baseline; gap: 4px;
}
.stats-sentinel-token:not(:first-child)::before {
  content: '\00b7'; color: var(--text-secondary); margin-right: 4px;
}
.stats-sentinel-count {
  font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 6: Build and run the suite**

Run: `npm run build`
Expected: build succeeds, no esbuild/JSX errors.

Run: `npm test`
Expected: PASS (full suite unchanged from Task 4).

- [ ] **Step 7: Manual render check (no customer data in output)**

Load `dist/` as an unpacked extension (or reload it), open the Console → Dataset Management → pick a collection → **Stats** tab. Confirm:
- A "Suspicious Values" section appears directly below "Field Quality" with its own loading/done status.
- A collection with placeholder strings lists each field with its sentinel tokens and counts (e.g. a field showing `null ×N`); a clean collection shows the green "No suspicious placeholder strings found".
- The Health number in Overview drops when a field is sentinel-only, and the tab-bar dot reflects it.
- Do NOT paste real customer field values/names into the session; describe results generically.

---

## Self-Review

**1. Spec coverage:**
- Spec §1 (new check) → Task 1. ✓
- Spec §2 (transform) → Task 2. ✓
- Spec §3 (health penalty, folded into emptiness, 7th optional param) → Task 3. ✓
- Spec §4 (tab-bar dot, optional input, five stay required) → Task 4. ✓
- Spec §5 (dedicated section below Field Quality, per-sentinel breakdown, `.stats-ok` empty state, reused `.stats-dist-special`, `.stats-sentinel-*`) → Task 5. ✓
- Spec §6 (tests) → distributed across Tasks 1–4 (pipeline shape + `SENTINEL_STRINGS`; transform; scoring incl. backward-compat + dedup; summary penalty + absence). ✓
- Spec "Backward compatibility": existing `buildAllPipelines` count test updated (Task 1); `transformStatsResults` per-key tests unaffected (Task 2); 6-arg `computeHealthScore` + clean/required-missing summary tests unaffected (Tasks 3–4). ✓
- Spec "prefetch propagation": no code change needed; called out in Task 4 Step 5. ✓
- Spec privacy note → Global Constraints + Task 5 Step 7. ✓

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" placeholders. The literal `'tbd'`/`'.'` tokens are sentinel data, not unfinished work. Every code step shows complete code. ✓

**3. Type consistency:** `SENTINEL_STRINGS` (array, 12 tokens) used identically in Task 1 builder and tests. `buildSentinelStringsPipeline(fields)` → `[fieldsOnly, {$facet}]` consistent. `transformSentinels`/`transformStatsResults().sentinels` shape `{field,total,values:[{value,count}]}` consistent across Tasks 2, 3 (reads `.field`), 4 (cache fixture matches `{result:[{<encKey>:[{_id,count}]}]}`), and 5 (renders `.field`, `.values[].value`, `.values[].count`). `computeHealthScore(...,fields,sentinels=null)` arg order consistent across Tasks 3, 4, 5. Cache key `stats_sentinels` consistent with `STATS_CHECKS` entry `'sentinels'` (prefetch/panel use `stats_${key}`). ✓

No issues found.
