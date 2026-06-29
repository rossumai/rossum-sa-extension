# Stats tab — suspicious string-sentinel detection

**Date:** 2026-06-29
**Status:** Approved (design); pending spec review → implementation plan
**Area:** Console → Dataset Management (MDH) → Collection Stats panel

## Problem

The Stats panel's **Field Quality** section reports a field as fully present
(`100%` coverage) whenever the value is a real, non-`null`, non-`""` string.
A field whose value is the literal text `"null"` (or `"N/A"`, `"none"`, `"-"`,
…) therefore looks perfectly healthy while actually carrying *placeholder /
absence* data. These string sentinels are invisible to every current check:

- Coverage counts them as present (BSON type is `string`, not `null`/`missing`).
- The Null / Missing / Empty columns count only real `null`, absent fields,
  and exact `""`.

We want the Stats tab to surface these suspicious values and reflect them in the
health score.

## Decisions (confirmed with the user)

1. **Scope — broad placeholder set.** Normalized (lowercased + whitespace-
   trimmed) match against:
   `null, none, nan, undefined, nil, n/a, na, tbd, unknown, -, --, .`
   Matching is case-insensitive and trim-tolerant, so `"NULL"`, `" None "`,
   `"Null"` all count. Numeric `0`, boolean, and real data are **not** flagged
   (only `string`-typed values are inspected).
2. **Health score — penalize.** A field that contains any sentinel string is
   folded into the existing **emptiness** component (treated like a field with
   null/empty values). Scores shift downward on affected collections and the
   tab-bar warning dot can light up where it previously did not. No new weighted
   component; the formula weights are unchanged.
3. **Presentation — dedicated section.** A new "Suspicious Values" section
   directly below Field Quality, showing a per-field, per-sentinel breakdown
   (e.g. `status: n/a ×89 · none ×12`). Not a new table column.

## Architecture

The Stats panel already runs a fixed list of independent checks
(`STATS_CHECKS`), each built by `buildAllPipelines(fields)`, executed in
parallel by both `StatsPanel.jsx` (foreground) and `prefetch.js` (background),
cached under `stats_<key>`, and (for the five health inputs) folded into the
tab-bar summary by `updateStatsSummary`. We extend this existing machinery with
one new check rather than inventing a new path.

### 1. New check `sentinels` — `src/mdh/statsPipelines.js`

```js
// Normalized (lowercase, trimmed) sentinel tokens — single source of truth.
export const SENTINEL_STRINGS = [
  'null', 'none', 'nan', 'undefined', 'nil',
  'n/a', 'na', 'tbd', 'unknown', '-', '--', '.',
];

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

- Same `$facet`-per-field shape as the existing String/Type/Distribution
  checks, so cost and behavior are consistent with the panel's other checks.
  It is *lighter* than `buildValueDistributionPipeline` because the inner
  `$match … $in` keeps only sentinel matches before grouping.
- The `$type === 'string'` guard ensures `$trim`/`$toLower` never run on
  non-string values (which would error), and means numbers/dates/objects are
  never flagged.
- Grouping by the **normalized** token rolls `"NULL"`, `" null "`, `"Null"`
  into a single `null` bucket — matching the case-insensitive intent.

Register the check:

```js
export const STATS_CHECKS = [ …existing…, 'sentinels' ];
export function buildAllPipelines(fields) {
  return { …existing…, sentinels: buildSentinelStringsPipeline(fields) };
}
```

This single registration propagates automatically to:
- `StatsPanel.jsx` — runs every `STATS_CHECKS` key in parallel and caches it.
- `prefetch.js::prefetchStats` — generic loop over `STATS_CHECKS` +
  `buildAllPipelines`, then calls `updateStatsSummary`.

### 2. Transform — `src/mdh/statsSummary.js`

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

Add a sixth key to `transformStatsResults`, null-tolerant exactly like the
other five (a check that errored during prefetch yields `null`, and consumers
render the pieces that resolved):

```js
sentinels: rawCache.sentinels ? transformSentinels(rawCache.sentinels, fields) : null,
```

### 3. Health-score penalty — `computeHealthScore`

`sentinels` is added as a **7th, optional, trailing parameter** so every
existing 6-argument call site and test keeps producing identical results.

```js
export function computeHealthScore(coverage, empties, types, strings, schemaShapes, fields, sentinels = null) {
  …
  // Emptiness: ratio of fields with no empty/null/missing/sentinel issues
  const affected = new Set();
  for (const e of (empties || []))   affected.add(e.field);
  for (const s of (sentinels || [])) affected.add(s.field);
  const emptinessScore = ((fields.length - affected.size) / fields.length) * 100;
  …
}
```

`empties` already contains at most one entry per field, so when `sentinels` is
`null`/`[]` the union size equals the old `empties.length` → the emptiness
component is **byte-identical to today**. A field appearing in both sets is
counted once. Weights (`0.25 / 0.20 / 0.15 / 0.20 / 0.20`) are unchanged.

### 4. Tab-bar dot — `updateStatsSummary`

Read the new cache key, but treat it as **optional**: the original five stay
required (missing one → summary `null`, unchanged), while a missing/errored
sentinel check simply skips the penalty instead of suppressing the whole
summary.

```js
const rawCache = {
  coverage:  cache.get(collection, 'stats_coverage'),
  empties:   cache.get(collection, 'stats_empties'),
  types:     cache.get(collection, 'stats_types'),
  strings:   cache.get(collection, 'stats_strings'),
  schema:    cache.get(collection, 'stats_schema'),
  sentinels: cache.get(collection, 'stats_sentinels'), // optional
};
const t = transformStatsResults(rawCache, fields);
if (t.coverage === null || t.empties === null || t.types === null
    || t.strings === null || t.schemaShapes === null) {
  statsSummary.value = null;
  return;
}
const health = computeHealthScore(
  t.coverage, t.empties, t.types, t.strings, t.schemaShapes, fields, t.sentinels,
);
```

In the normal case (the check succeeds, foreground or via prefetch) the dot
reflects the penalty. Only an actual sentinel-check failure degrades to the
old, penalty-free dot — consistent with the panel's "only warn on provable
issues" philosophy while maximizing backward compatibility.

### 5. UI — `src/mdh/components/StatsPanel.jsx`

- New state `const [sentinels, setSentinels] = useState(null);` (reset in the
  run-reset block alongside the others).
- `resultHandlers.sentinels = (res) => setSentinels(transformStatsResults({ sentinels: res }, discoveredFields).sentinels);`
- Live health computation (currently `StatsPanel.jsx:394`) passes `sentinels`
  as the 7th argument.
- `SECTION_ORDER` gains `'sentinels'` immediately after `'coverage'`. (Adding it
  to `SECTION_ORDER` automatically includes it in `allKeys`/progress counting.)
- New section, gated on `sentinels && canShow('sentinels')`, with its own
  `statuses.sentinels` status:

  ```
  Section "Suspicious Values"
    note: these values pass the coverage check (they're real strings) but
          usually represent missing/placeholder data.
    if no field flagged → .stats-ok "No suspicious placeholder strings found"
    else → per-field rows: <FieldName> : <token chip ×count> · <token chip ×count>
  ```

  Token chips reuse `.stats-dist-special`; a few small `.stats-sentinel-*`
  layout classes added to `src/console/console.css`.

### 6. Tests

- `tests/mdh-pipelines.test.js` — `SENTINEL_STRINGS` contents;
  `buildSentinelStringsPipeline` emits `fieldsOnly` + a `$facet` keyed by
  `encKey(field)` with the expected normalize→`$in`→`$group` stages; `sentinels`
  present in `STATS_CHECKS` and `buildAllPipelines`.
- `tests/mdh-stats-summary.test.js`:
  - `transformSentinels` — rollup of buckets to `{field,total,values}`, filter
    to `total>0`, ordering preserved; null raw → null output via
    `transformStatsResults`.
  - `computeHealthScore` — penalty when a sentinel-only field is supplied;
    **identical score when `sentinels` omitted / `[]`** (backward compat);
    a field present in both `empties` and `sentinels` counted once.
  - `updateStatsSummary` — applies the penalty when `stats_sentinels` is
    seeded; ignores its absence (clean-collection fixture without
    `stats_sentinels` still scores as before).

## Backward compatibility summary

- New trailing optional param on `computeHealthScore`; all existing call sites
  and the 6-arg unit tests are unaffected.
- New optional key in `transformStatsResults`; existing per-key assertions
  unaffected (no whole-object `toEqual`).
- New optional cache input in `updateStatsSummary`; the five required inputs
  and their tests are unchanged. Absent/errored sentinel data → old behavior.
- New `STATS_CHECKS` entry adds one parallel aggregation; older cached
  `stats_*` entries (without `stats_sentinels`) simply re-run the missing check
  on next visit. No persisted-state migration needed.

## Non-goals / out of scope

- No new table column in Field Quality (explicitly chose the dedicated section).
- No configurability/UI for editing the sentinel set in v1 (`SENTINEL_STRINGS`
  is a code constant — the single source of truth, easily extended later).
- No detection of numeric placeholder values (0, 999999) or sentinel dates —
  those remain the domain of the existing Numeric/Date sections' notes.
- Display shows normalized tokens; original-casing variants are intentionally
  rolled up (not separately enumerated).

## Privacy

The feature surfaces only sentinel tokens (`null`, `n/a`, …), field names, and
counts — the same class of data the Stats panel already renders. No new
customer-data exposure. Any live-org verification must avoid surfacing real
customer values or names in transcripts/commits.
