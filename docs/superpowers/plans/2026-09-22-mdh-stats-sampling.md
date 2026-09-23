# MDH Stats Sampling Implementation Plan

> **SUPERSEDED SIZING MODEL, 2026-09-22.** This plan executed against a four-option sample-size
> control (1000/5000/25000/Exact) sized as `total > 20 × sampleSize`, persisted as
> `mdhStatsSampleSize`. The owner rejected that rule after this plan landed — see spec §13 — and it
> was replaced by a byte/cell-budgeted sample (`affordableRows` in `src/mdh/statsPipelines.ts`)
> behind a two-option Sample/Exact control, persisted as `mdhStatsMode`. **None of the "exact
> values" below, nor `mdhStatsSampleSize`, nor the `20 × sampleSize` threshold, exist in the shipped
> code any more.** This file stays as the historical record of what Tasks 1–13 actually built and
> tested at the time; read `docs/superpowers/specs/2026-09-22-mdh-stats-sampling-design.md` §13 for
> what is current. Passages below that assert the old constants as ongoing fact are marked
> **[SUPERSEDED]** rather than rewritten.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Collection Stats tab usable on multi-million-document collections by replacing eleven full-collection scans with one sampled read profiled in the browser.

**Architecture:** Above a derived threshold the panel issues a single `$sample` + `$project` query and a new pure module (`statsCompute.ts`) walks the returned documents, emitting the **same raw response shapes** the existing server pipelines emit. Every transform, the health score and the tab-bar dot therefore stay untouched. Below the threshold the existing exact pipelines run unchanged, and on any collection where both can run they must agree.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly`), Preact + `@preact/signals`, Vitest + jsdom, esbuild. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-mdh-stats-sampling-design.md` — read it before Task 1. §5 ("Semantics `statsCompute.ts` must reproduce") is the contract Tasks 2–4 implement.

## Global Constraints

Copied from the repo's standing rules and the spec. Every task's requirements implicitly include this section.

- **No commits without the owner naming a commit.** Each task's final step stages with `git add` and STOPS. Do not run `git commit`. If the owner later approves, the whole run is **one** commit, not one per task.
- **Tests run `src/`, the browser runs `dist/`.** Run `npm run build` before asking anyone to reload the extension.
- **Every file is TypeScript.** No `.js`/`.jsx` files. Component tests are `.test.tsx`; everything else is `.test.ts`. Imports still spell `.js`/`.jsx` — do not rewrite them.
- **`erasableSyntaxOnly`:** no `enum`, no `namespace`, no parameter properties.
- **Do not annotate a contextually typed parameter.** A callback handed to `map`/`filter`/`vi.fn` already has a type.
- **Assert null-ness once, where the value is produced** — `const btn = root.querySelector('.x')!;` then plain `btn.click()`.
- **No bare single-letter or two-letter class names in JSX.** `minify: true` shortens CSS-Module locals to one or two characters and they are unique only among themselves.
- **`\uXXXX` does not work in JSX text or attribute values.** Use `{'≥'}`, a literal character, or an HTML entity in a text child.
- **No customer names or customer data** in code, comments, tests or fixtures. Use `acme` / `example` / `org` / `partner-sandbox.rossum.app`.
- **Gate every task on:** `npm run typecheck && npm test && npm run format:check`. Prettier 3.9.6 is not idempotent on `vi.fn().mockResolvedValue({…})` — if `format:check` fails after one `--write`, run it again.
- **[SUPERSEDED]** Exact values that must not drift, AS OF THIS PLAN'S EXECUTION: default sample size
  **5000**, options **1000 / 5000 / 25000 / Exact**, `STATS_EXACT = 0`, `SAMPLE_RATIO_DIVISOR = 20`,
  storage key **`mdhStatsSampleSize`**. None of these survive the spec §13 revision: the control is
  now Sample/Exact with no numeric options, there is no ratio divisor, and the storage key is
  `mdhStatsMode`. `STATS_EXACT = 0` is the one value that DID carry forward unchanged.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/mdh/statsCompute.ts` **(new)** | Pure. MongoDB value semantics (Task 2) and the ten check emitters (Tasks 3–4). No DOM, no network. |
| `src/mdh/statsPipelines.ts` | Gains the sampling rule and the one sampled-read pipeline. Existing builders untouched. |
| `src/mdh/statsView.ts` | `buildFieldProfiles` gains `analyzed`. |
| `src/mdh/store.ts` | `statsSampleSize` signal, options, coercion. |
| `src/mdh/index.tsx` | Boot read and persistence effect for `mdhStatsSampleSize`. |
| `src/mdh/components/StatsPanel.tsx` | Chooses exact vs sampled; hosts the toolbar control. |
| `src/mdh/components/StatsSummary.tsx` | Info strip replaces the warning; docSize min/max guard. |
| `src/mdh/components/StatsFieldCard.tsx` | Distinct-count meta row. |
| `src/mdh/prefetch.ts` | Sampled prefetch + in-flight dedupe. |
| `src/console/console.css` | `.stats-note`; `.stats-fcard-meta` contrast fix. |
| `tests/mdh-stats-compute.test.ts` **(new)** | Semantics cases + differential equivalence. |
| `tests/mdh-stats-sampling.test.ts` **(new)** | The sampling rule, the pipeline, the preference. |
| `tests/mdh-stats-panel.test.tsx` **(new)** | Panel branching and the toolbar control. |
| `tests/mdh-stats-cards.test.tsx` **(new)** | Info strip and the distinct meta row. |
| `tests/mdh-stats-view.test.ts` | Gains `analyzed` cases. |

---

### Task 1: The sampling rule and the sampled-read pipeline

**Files:**
- Modify: `src/mdh/statsPipelines.ts` (append after `buildAllPipelines`)
- Test: `tests/mdh-stats-sampling.test.ts` (create)

**Interfaces:**
- Consumes: `MAX_FIELDS`, `fieldsOnly` conventions already in the file.
- Produces: `STATS_EXACT: 0`, `STATS_SAMPLE_OPTIONS: number[]`, `STATS_SAMPLE_DEFAULT: 5000`, `SAMPLE_RATIO_DIVISOR: 20`, `shouldSample(total: number, size: number): boolean`, `buildSampleReadPipeline(fields: string[], size: number): any[]`, `sampleSizeLabel(size: number): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-stats-sampling.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  STATS_EXACT,
  STATS_SAMPLE_OPTIONS,
  SAMPLE_RATIO_DIVISOR,
  shouldSample,
  buildSampleReadPipeline,
  sampleSizeLabel,
} from '../src/mdh/statsPipelines.js';

describe('shouldSample', () => {
  // $sample only takes MongoDB's random-cursor path while N is under 5% of the
  // collection; at or above that it scans and sorts, which costs at least as
  // much as the exact pipeline it would replace. 5% == 1/20.
  it('samples only when the collection is more than 20x the sample size', () => {
    expect(SAMPLE_RATIO_DIVISOR).toBe(20);
    expect(shouldSample(100_001, 5000)).toBe(true);
    expect(shouldSample(100_000, 5000)).toBe(false);
    expect(shouldSample(99_999, 5000)).toBe(false);
  });

  it('moves the threshold with the sample size', () => {
    expect(shouldSample(50_000, 1000)).toBe(true);
    expect(shouldSample(50_000, 25_000)).toBe(false);
  });

  it('never samples on the Exact setting, at any size', () => {
    expect(shouldSample(50_000_000, STATS_EXACT)).toBe(false);
  });
});

describe('buildSampleReadPipeline', () => {
  it('samples first, then projects the analysed fields plus the top-level key names', () => {
    const p = buildSampleReadPipeline(['a', 'b.c'], 5000);
    expect(p[0]).toEqual({ $sample: { size: 5000 } });
    expect(p[1].$project.a).toBe(1);
    expect(p[1].$project['b.c']).toBe(1);
    expect(p[1].$project._id).toBe(0);
    // `_topKeys` is what lets the schema-shape check survive the projection:
    // the key NAMES travel, the values stay on the server.
    expect(p[1].$project._topKeys).toEqual({
      $map: { input: { $objectToArray: '$$ROOT' }, as: 'k', in: '$$k.k' },
    });
    expect(p).toHaveLength(2);
  });

  it('$sample is the first stage, which is what keeps the random cursor available', () => {
    expect(Object.keys(buildSampleReadPipeline(['a'], 1000)[0])).toEqual(['$sample']);
  });
});

describe('sampleSizeLabel', () => {
  it('labels the options the way the control renders them', () => {
    expect(STATS_SAMPLE_OPTIONS).toEqual([1000, 5000, 25000, STATS_EXACT]);
    expect(sampleSizeLabel(1000)).toBe('1k');
    expect(sampleSizeLabel(5000)).toBe('5k');
    expect(sampleSizeLabel(25000)).toBe('25k');
    expect(sampleSizeLabel(STATS_EXACT)).toBe('Exact');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-sampling.test.ts`
Expected: FAIL — `No "STATS_EXACT" export is defined on the module`.

- [ ] **Step 3: Write the implementation**

Append to `src/mdh/statsPipelines.ts`:

```ts
// ── Sampling ────────────────────────────────────
//
// `$sample` only takes MongoDB's pseudo-random cursor while it is the first
// stage and N is under 5% of the collection; at or above that it falls back to
// a collection scan plus a random sort, which costs at least as much as the
// exact pipeline it would replace. So the threshold is derived from the sample
// size (5% == 1/20) rather than chosen — with the default 5000 it lands at
// 100,000 documents, and it moves when the user moves the control.
export const SAMPLE_RATIO_DIVISOR = 20;

// The "Exact" setting. 0 is not a sample size; it means run the existing
// full-collection pipelines whatever the collection holds.
export const STATS_EXACT = 0;
export const STATS_SAMPLE_OPTIONS = [1000, 5000, 25000, STATS_EXACT];
export const STATS_SAMPLE_DEFAULT = 5000;

export function shouldSample(total: number, size: number): boolean {
  if (size === STATS_EXACT) return false;
  return total > SAMPLE_RATIO_DIVISOR * size;
}

export function sampleSizeLabel(size: number): string {
  if (size === STATS_EXACT) return 'Exact';
  return size >= 1000 ? `${size / 1000}k` : String(size);
}

// The single read that replaces eleven full-collection scans. `_topKeys`
// carries the top-level key NAMES so the schema-shape check survives the
// projection — shipping whole documents to the browser is the cost this whole
// design exists to avoid. It includes `_id`, matching the server pipeline,
// which derives fieldCount as $size(_keys) - 1.
export function buildSampleReadPipeline(fields: string[], size: number): any[] {
  const project: Record<string, any> = { _id: 0 };
  for (const f of fields) project[f] = 1;
  project._topKeys = { $map: { input: { $objectToArray: '$$ROOT' }, as: 'k', in: '$$k.k' } };
  return [{ $sample: { size } }, { $project: project }];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-sampling.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/statsPipelines.ts tests/mdh-stats-sampling.test.ts
```

Do not commit. If `format:check` fails, run `npm run format` and re-run `format:check` before staging.

---

### Task 2: MongoDB value semantics

The seven rows of spec §5 that make the obvious JavaScript wrong. Isolated here because they are the whole risk of the design; Tasks 3 and 4 are arithmetic on top of them.

**Files:**
- Create: `src/mdh/statsCompute.ts`
- Test: `tests/mdh-stats-compute.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolvePath(doc: any, path: string): { found: boolean; value: any }`, `bsonType(v: any): string`, `mongoTrim(s: string): string`, `hasLeadingWs(s: string): boolean`, `hasTrailingWs(s: string): boolean`, `cpLength(s: string): number`, `groupKey(v: any): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-stats-compute.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  resolvePath,
  bsonType,
  mongoTrim,
  hasLeadingWs,
  hasTrailingWs,
  cpLength,
  groupKey,
} from '../src/mdh/statsCompute.js';

describe('resolvePath', () => {
  it('distinguishes a missing path from a null value', () => {
    expect(resolvePath({ a: null }, 'a')).toEqual({ found: true, value: null });
    expect(resolvePath({}, 'a')).toEqual({ found: false, value: undefined });
    expect(resolvePath({ a: {} }, 'a.b')).toEqual({ found: false, value: undefined });
  });

  it('traverses an array of documents the way $a.b does', () => {
    expect(resolvePath({ a: [{ b: 1 }, { b: 2 }] }, 'a.b')).toEqual({ found: true, value: [1, 2] });
  });

  it('omits elements that lack the key, rather than emitting a hole', () => {
    expect(resolvePath({ a: [{ b: 1 }, {}, { b: 3 }] }, 'a.b')).toEqual({
      found: true,
      value: [1, 3],
    });
    expect(resolvePath({ a: [1, 2] }, 'a.b')).toEqual({ found: true, value: [] });
  });

  it('returns a whole array when the path stops at it', () => {
    expect(resolvePath({ a: [1, 2] }, 'a')).toEqual({ found: true, value: [1, 2] });
  });

  it('does not walk through a scalar', () => {
    expect(resolvePath({ a: 'text' }, 'a.b')).toEqual({ found: false, value: undefined });
  });
});

describe('bsonType', () => {
  it('never reports an EJSON wrapper as an object — they are BSON scalars server-side', () => {
    expect(bsonType({ $oid: '507f1f77bcf86cd799439011' })).toBe('objectId');
    expect(bsonType({ $date: '2026-01-01T00:00:00Z' })).toBe('date');
  });

  it('collapses every numeric subtype to "number", which is what the UI already does', () => {
    expect(bsonType(1)).toBe('number');
    expect(bsonType(0.5)).toBe('number');
    expect(bsonType({ $numberLong: '9007199254740993' })).toBe('number');
    expect(bsonType({ $numberDecimal: '1.10' })).toBe('number');
  });

  it('names the remaining types the way $type does', () => {
    expect(bsonType(null)).toBe('null');
    expect(bsonType('x')).toBe('string');
    expect(bsonType(true)).toBe('bool');
    expect(bsonType([1])).toBe('array');
    expect(bsonType({ a: 1 })).toBe('object');
  });
});

describe('mongoTrim', () => {
  it('trims NUL, which String.prototype.trim does not', () => {
    expect(mongoTrim('\u0000abc\u0000')).toBe('abc');
    expect('\u0000abc\u0000'.trim()).toBe('\u0000abc\u0000');
  });

  it('does not trim the BOM, which String.prototype.trim does', () => {
    expect(mongoTrim('\ufeffabc')).toBe('\ufeffabc');
    expect('\ufeffabc'.trim()).toBe('abc');
  });

  it('trims the ordinary and the exotic whitespace $trim names', () => {
    expect(mongoTrim('  a\t\n')).toBe('a');
    // Escapes, never literal bytes: a raw U+00A0 or U+2003 in a source file is
    // invisible to review. U+00A0 and U+2003 ARE in $trim's set; U+3000 is not,
    // so it survives the trim.
    expect(mongoTrim('\u00a0\u2003a\u3000')).toBe('a\u3000');
  });

  it('reports leading and trailing separately, as the pipeline does', () => {
    expect(hasLeadingWs(' a')).toBe(true);
    expect(hasTrailingWs(' a')).toBe(false);
    expect(hasTrailingWs('a ')).toBe(true);
  });
});

describe('cpLength', () => {
  it('counts code points like $strLenCP, not UTF-16 units', () => {
    expect(cpLength('a\u{1F600}b')).toBe(3);
    expect('a\u{1F600}b'.length).toBe(4);
  });
});

describe('groupKey', () => {
  it('separates values that differ only by type', () => {
    expect(groupKey(1)).not.toBe(groupKey('1'));
    expect(groupKey(null)).not.toBe(groupKey('null'));
  });

  it('treats documents with different key ORDER as different, as BSON equality does', () => {
    expect(groupKey({ a: 1, b: 2 })).not.toBe(groupKey({ b: 2, a: 1 }));
  });

  it('treats an array as one value, in order', () => {
    expect(groupKey([1, 2])).toBe(groupKey([1, 2]));
    expect(groupKey([1, 2])).not.toBe(groupKey([2, 1]));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-compute.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mdh/statsCompute.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/mdh/statsCompute.ts`:

```ts
// Pure client-side equivalent of the Stats check pipelines, computed over one
// `$sample` read instead of eleven full-collection scans. DOM-free and
// network-free, like statsView.ts and the pure half of statsSummary.ts.
//
// Its contract is the RAW response shape: every emitter returns exactly what
// `api.aggregate` returns for the server pipeline it replaces, so statsView.ts,
// statsSummary.ts and their tests are untouched by sampling.
//
// The helpers below exist because the obvious JavaScript diverges from
// MongoDB. See the design spec's §5 table for the full list.

// Resolve a dotted path the way `$a.b.c` does, including MongoDB's implicit
// traversal of an array of documents — `$a.b` over `a: [{b:1},{b:2}]` is
// `[1,2]`, and elements without `b` are OMITTED rather than left as holes.
// `found` is what separates a missing path from a stored null; `?? null` would
// merge the two and `$type` reports them differently.
export function resolvePath(doc: any, path: string): { found: boolean; value: any } {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length; i++) {
    if (Array.isArray(cur)) {
      const rest = parts.slice(i).join('.');
      const out: any[] = [];
      for (const el of cur) {
        const r = resolvePath(el, rest);
        if (r.found) out.push(r.value);
      }
      return { found: true, value: out };
    }
    if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
    if (!(parts[i] in cur)) return { found: false, value: undefined };
    cur = cur[parts[i]];
  }
  return { found: true, value: cur };
}

// `$type`, with two deliberate departures.
//
// EJSON wrappers are BSON scalars server-side, so `$type` never says 'object'
// for them. And a JSON number carries no subtype, so int/long/double/decimal
// all report as 'number' — which every consumer already does anyway:
// `friendlyType` maps all four to 'number', and both `transformTypes` and
// `fieldTypeSummary` count distinct LOGICAL types so that a field holding 1 and
// 0.5 is not flagged as a type mix. The divergence is visible in the raw shape
// and invisible in every rendered number.
export function bsonType(v: any): string {
  // `undefined` is resolvePath's not-found sentinel. Reporting it as 'missing'
  // rather than falling through to 'object' makes this primitive correct on its
  // own, instead of relying on every caller writing `found ? bsonType(v) : …`.
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'bool';
  if (t === 'number') return 'number';
  if (t === 'object') {
    if ('$oid' in v) return 'objectId';
    if ('$date' in v) return 'date';
    if ('$numberLong' in v || '$numberInt' in v) return 'number';
    if ('$numberDouble' in v || '$numberDecimal' in v) return 'number';
    return 'object';
  }
  return 'object';
}

// The character class `$ltrim`/`$rtrim` use with no `chars` argument: MongoDB's
// documented set of 20 code points, ending at U+200A. It INCLUDES NUL and
// EXCLUDES the BOM, so String.prototype.trim is wrong on both — and it also
// excludes U+2028, U+2029, U+202F, U+205F and U+3000, so general "Unicode
// whitespace" is wrong the other way. U+3000 is the CJK full-width space: a
// client that trims it reports CJK values as carrying stray whitespace that the
// server does not see.
const WS = '\\u0000\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a';
const LEADING = new RegExp(`^[${WS}]+`);
const TRAILING = new RegExp(`[${WS}]+$`);

export function mongoTrim(s: string): string {
  return s.replace(LEADING, '').replace(TRAILING, '');
}
export function hasLeadingWs(s: string): boolean {
  return LEADING.test(s);
}
export function hasTrailingWs(s: string): boolean {
  return TRAILING.test(s);
}

// `$strLenCP` counts code points; `.length` counts UTF-16 units.
export function cpLength(s: string): number {
  return [...s].length;
}

// Identity for `$group: { _id: '$field' }` — distinct by value AND type, with
// an array grouped as one whole value. JSON.stringify preserves insertion
// order, which is what makes `{a:1,b:2}` and `{b:2,a:1}` distinct here, as they
// are in BSON. Do NOT sort the keys.
export function groupKey(v: any): string {
  return `${bsonType(v)}\u0000${JSON.stringify(v ?? null)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-compute.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/statsCompute.ts tests/mdh-stats-compute.test.ts
```

---

### Task 3: The four health-score checks

`coverage`, `empties`, `types` and `schema` — the inputs `computeHealthScore` needs, so the tab-bar dot works off a sampled run as soon as this task lands.

**Files:**
- Modify: `src/mdh/statsCompute.ts`
- Test: `tests/mdh-stats-compute.test.ts`

**Interfaces:**
- Consumes: `resolvePath`, `bsonType` from Task 2; `encKey` from `statsPipelines.ts`.
- Produces: `computeCoverage`, `computeEmpties`, `computeTypes`, `computeSchema` — each `(docs: any[], fields: string[]) => { result: any[] }` except `computeSchema(docs: any[]) => { result: any[] }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-stats-compute.test.ts`:

```ts
import {
  computeCoverage,
  computeEmpties,
  computeTypes,
  computeSchema,
} from '../src/mdh/statsCompute.js';
import { transformStatsResults } from '../src/mdh/statsSummary.js';

const enc = (f: string) => f.replace(/\./g, '__DOT__');

// One sample, shaped like what buildSampleReadPipeline returns: the analysed
// fields plus `_topKeys` (which includes _id, as the server pipeline's
// $objectToArray does).
const DOCS = [
  { supplier: 'ACME', amount: 10, _topKeys: ['_id', 'supplier', 'amount'] },
  { supplier: '', amount: 20, _topKeys: ['_id', 'supplier', 'amount'] },
  { supplier: null, amount: 30, _topKeys: ['_id', 'supplier', 'amount'] },
  { amount: 40, _topKeys: ['_id', 'amount'] },
];

describe('computeCoverage', () => {
  it('counts present as neither missing nor null, and carries the sample size as _total', () => {
    const r = computeCoverage(DOCS, ['supplier', 'amount']).result[0];
    expect(r._total).toBe(4);
    expect(r[`f_${enc('supplier')}`]).toBe(2); // 'ACME' and '' are both present
    expect(r[`f_${enc('amount')}`]).toBe(4);
  });
});

describe('computeEmpties', () => {
  it('separates null, missing and empty-string into their own counters', () => {
    const r = computeEmpties(DOCS, ['supplier']).result[0];
    expect(r[`null_${enc('supplier')}`]).toBe(1);
    expect(r[`missing_${enc('supplier')}`]).toBe(1);
    expect(r[`empty_${enc('supplier')}`]).toBe(1);
  });
});

describe('computeTypes', () => {
  it('buckets by $type including a "missing" bucket, sorted by count descending', () => {
    const buckets = computeTypes(DOCS, ['supplier']).result[0][enc('supplier')];
    expect(buckets).toEqual([
      { _id: 'string', count: 2 },
      { _id: 'null', count: 1 },
      { _id: 'missing', count: 1 },
    ]);
  });
});

describe('computeSchema', () => {
  it('groups by top-level field count excluding _id, biggest group first', () => {
    expect(computeSchema(DOCS).result).toEqual([
      { _id: 2, count: 3, sampleFields: ['_id', 'supplier', 'amount'] },
      { _id: 1, count: 1, sampleFields: ['_id', 'amount'] },
    ]);
  });
});

describe('the raw shape feeds the existing transforms unchanged', () => {
  it('produces a health-score input set transformStatsResults can read', () => {
    const t = transformStatsResults(
      {
        coverage: computeCoverage(DOCS, ['supplier', 'amount']),
        empties: computeEmpties(DOCS, ['supplier', 'amount']),
        types: computeTypes(DOCS, ['supplier', 'amount']),
        strings: { result: [{}] },
        schema: computeSchema(DOCS),
      },
      ['supplier', 'amount'],
    );
    expect(t.coverage).toEqual([
      { field: 'supplier', present: 2, total: 4, pct: 50 },
      { field: 'amount', present: 4, total: 4, pct: 100 },
    ]);
    expect(t.schemaShapes).toEqual([
      { fieldCount: 2, docCount: 3, sampleFields: ['amount', 'supplier'] },
      { fieldCount: 1, docCount: 1, sampleFields: ['amount'] },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-compute.test.ts`
Expected: FAIL — `No "computeCoverage" export is defined on the module`.

- [ ] **Step 3: Write the implementation**

Append to `src/mdh/statsCompute.ts`:

```ts
import { encKey } from './statsPipelines.js';

const SCHEMA_SHAPE_LIMIT = 20;

// Mirrors buildFieldCoveragePipeline: present == $type is not 'missing' AND the
// value is not null. An empty string and an empty array both count as present,
// exactly as the server's $cond does.
export function computeCoverage(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = { _id: null, _total: docs.length };
  for (const f of fields) row[`f_${encKey(f)}`] = 0;
  for (const doc of docs) {
    for (const f of fields) {
      const r = resolvePath(doc, f);
      if (r.found && r.value !== null) row[`f_${encKey(f)}`]++;
    }
  }
  return { result: [row] };
}

// Mirrors buildEmptyValuesPipeline: three independent counters per field.
export function computeEmpties(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = { _id: null };
  for (const f of fields) {
    const k = encKey(f);
    row[`null_${k}`] = 0;
    row[`missing_${k}`] = 0;
    row[`empty_${k}`] = 0;
  }
  for (const doc of docs) {
    for (const f of fields) {
      const k = encKey(f);
      const r = resolvePath(doc, f);
      if (!r.found) row[`missing_${k}`]++;
      else if (r.value === null) row[`null_${k}`]++;
      else if (r.value === '') row[`empty_${k}`]++;
    }
  }
  return { result: [row] };
}

// Mirrors buildTypePipeline. The 'missing' bucket is part of the contract —
// transformTypes and fieldTypeSummary both filter it out themselves.
export function computeTypes(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    const counts = new Map<string, number>();
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      const t = r.found ? bsonType(r.value) : 'missing';
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    row[encKey(f)] = [...counts.entries()]
      .map(([_id, count]) => ({ _id, count }))
      .sort((a, b) => b.count - a.count);
  }
  return { result: [row] };
}

// Mirrors buildSchemaConsistencyPipeline, reading `_topKeys` (which the sampled
// read projects) instead of re-deriving it from whole documents. fieldCount
// subtracts 1 for _id, and sampleFields is $first — the first shape seen wins,
// so iteration order matters and must stay document order.
export function computeSchema(docs: any[]): { result: any[] } {
  const shapes = new Map<number, { count: number; sampleFields: string[] }>();
  for (const doc of docs) {
    const keys: string[] = doc._topKeys || [];
    const fieldCount = keys.length - 1;
    const seen = shapes.get(fieldCount);
    if (seen) seen.count++;
    else shapes.set(fieldCount, { count: 1, sampleFields: keys });
  }
  return {
    result: [...shapes.entries()]
      .map(([_id, v]) => ({ _id, count: v.count, sampleFields: v.sampleFields }))
      .sort((a, b) => b.count - a.count)
      .slice(0, SCHEMA_SHAPE_LIMIT),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-compute.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/statsCompute.ts tests/mdh-stats-compute.test.ts
```

---

### Task 4: The six field-detail checks

`distribution`, `cardinality`, `strings`, `sentinels`, `numeric`, `dates`.

**Files:**
- Modify: `src/mdh/statsCompute.ts`
- Test: `tests/mdh-stats-compute.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers, `TOP_VALUES` and `SENTINEL_STRINGS` from `statsPipelines.ts`.
- Produces: `computeDistribution`, `computeCardinality`, `computeStrings`, `computeSentinels`, `computeNumeric`, `computeDates` — each `(docs: any[], fields: string[]) => { result: any[] }`; `computeSampledChecks(docs: any[], fields: string[]) => Record<string, { result: any[] }>` returning all ten keyed by `STATS_CHECKS` name; and `assembleSampledStats(docs: any[], fields: string[], storageRes: any) => Record<string, { result: any[] }>`, which adds the two checks that are not computed from the sample. **Tasks 7 and 10 both call `assembleSampledStats` — neither rebuilds it inline.**

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-stats-compute.test.ts`:

```ts
import {
  computeDistribution,
  computeCardinality,
  computeStrings,
  computeSentinels,
  computeNumeric,
  computeDates,
  computeSampledChecks,
  assembleSampledStats,
} from '../src/mdh/statsCompute.js';
import {
  transformCardinality,
  transformDistribution,
  transformNumeric,
  transformDates,
} from '../src/mdh/statsView.js';

const VDOCS = [
  { cur: 'EUR', amt: 10, when: { $date: '2026-01-02T00:00:00Z' }, _topKeys: ['_id', 'cur'] },
  { cur: 'EUR', amt: 5, when: { $date: '2026-03-04T00:00:00Z' }, _topKeys: ['_id', 'cur'] },
  { cur: ' usd ', amt: 20, _topKeys: ['_id', 'cur'] },
  { cur: 'n/a', _topKeys: ['_id', 'cur'] },
  { _topKeys: ['_id'] },
];

describe('computeDistribution', () => {
  // $group on a missing field yields an _id of null, so missing and stored null
  // land in ONE bucket. Reproducing that is what keeps the counts honest.
  it('groups by exact value, folding missing into the null bucket, top N by count', () => {
    const buckets = computeDistribution(VDOCS, ['cur']).result[0][enc('cur')];
    expect(buckets[0]).toEqual({ _id: 'EUR', count: 2 });
    expect(buckets).toContainEqual({ _id: null, count: 1 });
    expect(transformDistribution(computeDistribution(VDOCS, ['cur']), ['cur'])[0].values[0]).toEqual(
      { value: 'EUR', count: 2 },
    );
  });
});

describe('computeCardinality', () => {
  it('counts distinct groups, including the null bucket', () => {
    // 'EUR', ' usd ', 'n/a', null
    expect(transformCardinality(computeCardinality(VDOCS, ['cur']), ['cur'])).toEqual([
      { field: 'cur', distinct: 4 },
    ]);
  });
});

describe('computeStrings', () => {
  it('measures only string values, in code points, with leading/trailing counted apart', () => {
    const s = computeStrings(VDOCS, ['cur']).result[0][enc('cur')][0];
    expect(s.count).toBe(4); // EUR, EUR, ' usd ', 'n/a'
    expect(s.minLen).toBe(3);
    expect(s.maxLen).toBe(5);
    expect(s.leading).toBe(1);
    expect(s.trailing).toBe(1);
  });

  it('emits an empty facet array for a field with no strings, as $facet does', () => {
    expect(computeStrings(VDOCS, ['amt']).result[0][enc('amt')]).toEqual([]);
  });
});

describe('computeSentinels', () => {
  it('matches the normalized token, not the stored casing or padding', () => {
    const rows = computeSentinels(
      [{ f: 'N/A' }, { f: ' n/a ' }, { f: 'real' }],
      ['f'],
    ).result[0][enc('f')];
    expect(rows).toEqual([{ _id: 'n/a', count: 2 }]);
  });
});

describe('computeNumeric and computeDates', () => {
  it('reports min/max/avg over numbers only', () => {
    expect(transformNumeric(computeNumeric(VDOCS, ['amt']), ['amt'])).toEqual([
      { field: 'amt', count: 3, min: 5, max: 20, avg: 35 / 3 },
    ]);
  });

  it('reports the earliest and latest date, preserving the wire wrapper', () => {
    expect(transformDates(computeDates(VDOCS, ['when']), ['when'])).toEqual([
      {
        field: 'when',
        count: 2,
        earliest: { $date: '2026-01-02T00:00:00Z' },
        latest: { $date: '2026-03-04T00:00:00Z' },
      },
    ]);
  });

  it('omits a field with no values of that type, as the $match does', () => {
    expect(transformNumeric(computeNumeric(VDOCS, ['cur']), ['cur'])).toEqual([]);
  });
});

describe('assembleSampledStats', () => {
  const storageRes = {
    result: [{ storageStats: { count: 4_000_000, avgObjSize: 812, size: 3_248_000_000 } }],
  };

  it('takes document size from $collStats, which is exact, not from the sample', () => {
    const d = assembleSampledStats(VDOCS, ['cur'], storageRes).docSize.result[0];
    expect(d.count).toBe(4_000_000);
    expect(d.avgSize).toBe(812);
    expect(d.totalSize).toBe(3_248_000_000);
    // $bsonSize has no client equivalent and storage stats carry no range, so
    // a sampled min/max would be a narrower range presented as the true one.
    expect(d.minSize).toBeNull();
    expect(d.maxSize).toBeNull();
  });

  it('passes the storage response through untouched', () => {
    expect(assembleSampledStats(VDOCS, ['cur'], storageRes).storage).toBe(storageRes);
  });

  it('survives a storage response with no stats', () => {
    const d = assembleSampledStats(VDOCS, ['cur'], { result: [] }).docSize.result[0];
    expect(d.count).toBe(VDOCS.length);
    expect(d.avgSize).toBeNull();
  });
});

describe('computeSampledChecks', () => {
  it('returns all ten document-reading checks under their STATS_CHECKS names', () => {
    const all = computeSampledChecks(VDOCS, ['cur', 'amt']);
    expect(Object.keys(all).sort()).toEqual(
      [
        'cardinality',
        'coverage',
        'dates',
        'distribution',
        'empties',
        'numeric',
        'schema',
        'sentinels',
        'strings',
        'types',
      ].sort(),
    );
    expect(all.coverage.result[0]._total).toBe(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-compute.test.ts`
Expected: FAIL — `No "computeDistribution" export is defined on the module`.

- [ ] **Step 3: Write the implementation**

Append to `src/mdh/statsCompute.ts` (extend the existing import from `./statsPipelines.js` to `encKey, TOP_VALUES, SENTINEL_STRINGS`):

```ts
// Value buckets for $group: {_id: '$f'}. A MISSING field groups as null, the
// same bucket a stored null lands in — reproducing that fold is what keeps
// distribution and cardinality agreeing with the server.
function valueBuckets(docs: any[], field: string) {
  const buckets = new Map<string, { _id: any; count: number }>();
  for (const doc of docs) {
    const r = resolvePath(doc, field);
    const v = r.found ? r.value : null;
    const k = groupKey(v);
    const seen = buckets.get(k);
    if (seen) seen.count++;
    else buckets.set(k, { _id: v, count: 1 });
  }
  return buckets;
}

export function computeDistribution(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    row[encKey(f)] = [...valueBuckets(docs, f).values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_VALUES);
  }
  return { result: [row] };
}

export function computeCardinality(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    const n = valueBuckets(docs, f).size;
    // $count emits nothing for an empty stream, so an empty facet array is the
    // honest shape — transformCardinality already reads that as 0.
    row[encKey(f)] = n > 0 ? [{ distinct: n }] : [];
  }
  return { result: [row] };
}

export function computeStrings(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    let count = 0;
    let minLen = Infinity;
    let maxLen = 0;
    let sumLen = 0;
    let leading = 0;
    let trailing = 0;
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      if (!r.found || typeof r.value !== 'string') continue;
      const len = cpLength(r.value);
      count++;
      sumLen += len;
      if (len < minLen) minLen = len;
      if (len > maxLen) maxLen = len;
      if (hasLeadingWs(r.value)) leading++;
      if (hasTrailingWs(r.value)) trailing++;
    }
    row[encKey(f)] =
      count > 0
        ? [{ _id: null, count, minLen, maxLen, avgLen: sumLen / count, leading, trailing }]
        : [];
  }
  return { result: [row] };
}

export function computeSentinels(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    const counts = new Map<string, number>();
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      if (!r.found || typeof r.value !== 'string') continue;
      const norm = mongoTrim(r.value).toLowerCase();
      if (!SENTINEL_STRINGS.includes(norm)) continue;
      counts.set(norm, (counts.get(norm) || 0) + 1);
    }
    row[encKey(f)] = [...counts.entries()]
      .map(([_id, count]) => ({ _id, count }))
      .sort((a, b) => b.count - a.count);
  }
  return { result: [row] };
}

export function computeNumeric(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      if (!r.found || typeof r.value !== 'number') continue;
      count++;
      sum += r.value;
      if (r.value < min) min = r.value;
      if (r.value > max) max = r.value;
    }
    row[encKey(f)] = count > 0 ? [{ _id: null, count, min, max, avg: sum / count }] : [];
  }
  return { result: [row] };
}

// Dates arrive as `{ $date: … }`. Compare on the parsed timestamp but emit the
// value as it came off the wire — formatDate reads `d.$date`.
function dateMs(v: any): number {
  const raw = typeof v === 'string' ? v : v.$date;
  const s = typeof raw === 'object' && raw !== null ? raw.$numberLong : raw;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? NaN : t;
}

export function computeDates(docs: any[], fields: string[]): { result: any[] } {
  const row: Record<string, any> = {};
  for (const f of fields) {
    let count = 0;
    let earliest: any = null;
    let latest: any = null;
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const doc of docs) {
      const r = resolvePath(doc, f);
      if (!r.found || bsonType(r.value) !== 'date') continue;
      const ms = dateMs(r.value);
      if (Number.isNaN(ms)) continue;
      count++;
      if (ms < minMs) {
        minMs = ms;
        earliest = r.value;
      }
      if (ms > maxMs) {
        maxMs = ms;
        latest = r.value;
      }
    }
    row[encKey(f)] = count > 0 ? [{ _id: null, count, earliest, latest }] : [];
  }
  return { result: [row] };
}

// Every document-reading check, from one sample.
export function computeSampledChecks(
  docs: any[],
  fields: string[],
): Record<string, { result: any[] }> {
  return {
    coverage: computeCoverage(docs, fields),
    empties: computeEmpties(docs, fields),
    types: computeTypes(docs, fields),
    distribution: computeDistribution(docs, fields),
    cardinality: computeCardinality(docs, fields),
    strings: computeStrings(docs, fields),
    numeric: computeNumeric(docs, fields),
    dates: computeDates(docs, fields),
    sentinels: computeSentinels(docs, fields),
    schema: computeSchema(docs),
  };
}

// The complete raw set StatsPanel and prefetch both publish, so neither builds
// it inline. `storage` is $collStats metadata passed straight through, and
// `docSize` is derived from it rather than from the sample: $bsonSize has no
// client equivalent and JSON byte length is not BSON byte length. min/max are
// null because storage stats do not carry them, and a sample's range is not
// the collection's.
export function assembleSampledStats(
  docs: any[],
  fields: string[],
  storageRes: any,
): Record<string, { result: any[] }> {
  const storage = storageRes?.result?.[0]?.storageStats || {};
  return {
    ...computeSampledChecks(docs, fields),
    storage: storageRes,
    docSize: {
      result: [
        {
          count: storage.count ?? docs.length,
          avgSize: storage.avgObjSize ?? null,
          minSize: null,
          maxSize: null,
          totalSize: storage.size ?? null,
        },
      ],
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-compute.test.ts`
Expected: PASS, 30 tests.

- [ ] **Step 5: Record the one divergence this task introduces**

Add to the spec's §5 "Known divergences, accepted", after the numeric-subtypes paragraph:

```markdown
**Arrays of numbers and dates.** The server's `numeric` and `dates` checks filter with
`$match: { f: { $type: 'number' } }`, a query-level `$type` that matches when ANY element of an
array field is a number. The client requires the value itself to be a number. A discovered leaf
path is a scalar in the documents it was discovered from — `allDiscoveredFields` treats an array as
a leaf and never descends — so this differs only for a field that is a scalar in some documents and
an array of numbers in others. Asserted by `computeNumeric`'s test rather than left implicit.
```

- [ ] **Step 6: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/statsCompute.ts tests/mdh-stats-compute.test.ts docs/superpowers/specs/2026-09-22-mdh-stats-sampling-design.md
```

---

### Task 5: Ratios divide by what was analysed

**Files:**
- Modify: `src/mdh/statsView.ts` (`buildFieldProfiles`)
- Test: `tests/mdh-stats-view.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildFieldProfiles` accepts an additional `analyzed?: number`; `diversityPct` divides by `analyzed ?? total`. `StatsPanel` is the only caller.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-stats-view.test.ts`:

```ts
describe('buildFieldProfiles with a sampled run', () => {
  const args = {
    fields: ['a'],
    coverage: [{ field: 'a', present: 500, total: 1000, pct: 50 }],
    empties: [],
    typeSummary: {},
    cardinality: [{ field: 'a', distinct: 250 }],
    distribution: [{ field: 'a', values: [{ value: 'x', count: 9 }] }],
    strings: [],
    numeric: [],
    dates: [],
    sentinels: [],
  };

  it('divides diversity by the analysed count, not the collection size', () => {
    // Without this, 250 distinct in a 1,000-doc sample of a 4,000,000-doc
    // collection reports as 0% diverse and scrambles the card order.
    const [p] = buildFieldProfiles({ ...args, total: 4_000_000, analyzed: 1000 });
    expect(p.diversityPct).toBe(25);
    expect(p.total).toBe(4_000_000);
  });

  it('is unchanged when analyzed is omitted', () => {
    const [p] = buildFieldProfiles({ ...args, total: 1000 });
    expect(p.diversityPct).toBe(25);
    expect(p.total).toBe(1000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-view.test.ts`
Expected: FAIL — `expected 0 to be 25`.

- [ ] **Step 3: Write the implementation**

In `src/mdh/statsView.ts`, add `analyzed` to the destructured parameter list of `buildFieldProfiles` and change the one ratio:

```ts
export function buildFieldProfiles({
  fields,
  total,
  analyzed,
  coverage,
  empties,
  typeSummary,
  cardinality,
  distribution,
  strings,
  numeric,
  dates,
  sentinels,
}: Record<string, any>) {
```

and replace the `diversityPct` line:

```ts
      // `total` is the collection; `analyzed` is what the numbers were computed
      // from, which on a sampled run is the sample size. Dividing a sample's
      // distinct count by the collection size reports every field as 0% diverse.
      diversityPct: (analyzed ?? total) > 0 ? Math.round((distinct / (analyzed ?? total)) * 100) : 0,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/statsView.ts tests/mdh-stats-view.test.ts
```

---

### Task 6: The `mdhStatsSampleSize` preference

> **[SUPERSEDED]** This preference was renamed `mdhStatsMode` per spec §13.2, storing `'sample'` /
> `'exact'` instead of a numeric size. The task below is left as executed at the time.

**Files:**
- Modify: `src/mdh/store.ts` (after the Stages-view options block, ~line 152)
- Modify: `src/mdh/index.tsx` (boot read list ~line 145, coercion ~line 179, persistence effect ~line 255)
- Test: `tests/mdh-stats-sampling.test.ts`

**Interfaces:**
- Consumes: `STATS_SAMPLE_OPTIONS`, `STATS_SAMPLE_DEFAULT` from Task 1.
- Produces: `statsSampleSize: Signal<number>` and `coerceStatsSampleSize(v: unknown): number` on `src/mdh/store.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-stats-sampling.test.ts`:

```ts
import { statsSampleSize, coerceStatsSampleSize } from '../src/mdh/store.js';
import { STATS_SAMPLE_DEFAULT } from '../src/mdh/statsPipelines.js';

describe('statsSampleSize preference', () => {
  it('defaults to 5000', () => {
    expect(statsSampleSize.value).toBe(5000);
    expect(STATS_SAMPLE_DEFAULT).toBe(5000);
  });

  it('accepts every offered option, including Exact', () => {
    for (const n of STATS_SAMPLE_OPTIONS) expect(coerceStatsSampleSize(n)).toBe(n);
  });

  it('falls back to the default for a stale or hand-edited value', () => {
    // A value outside the option list would otherwise reach $sample directly.
    expect(coerceStatsSampleSize(7)).toBe(5000);
    expect(coerceStatsSampleSize('nonsense')).toBe(5000);
    expect(coerceStatsSampleSize(null)).toBe(5000);
    expect(coerceStatsSampleSize(undefined)).toBe(5000);
  });

  it('reads a numeric string, as the stored value may be', () => {
    expect(coerceStatsSampleSize('25000')).toBe(25000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-sampling.test.ts`
Expected: FAIL — `No "statsSampleSize" export is defined on the module`.

- [ ] **Step 3: Write the implementation**

In `src/mdh/store.ts`, after `coerceStageSampleSize`:

```ts
// How many documents the Collection Stats tab profiles (persisted as
// mdhStatsSampleSize, wired like mdhStagesSampleSize). STATS_EXACT means run
// the full-collection pipelines whatever the size. Whether a given setting
// actually samples depends on the collection: see shouldSample.
export const statsSampleSize = signal(STATS_SAMPLE_DEFAULT);

export function coerceStatsSampleSize(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(v as string, 10);
  return STATS_SAMPLE_OPTIONS.includes(n) ? n : STATS_SAMPLE_DEFAULT;
}
```

Add the import at the top of `src/mdh/store.ts`:

```ts
import { STATS_SAMPLE_OPTIONS, STATS_SAMPLE_DEFAULT } from './statsPipelines.js';
```

In `src/mdh/index.tsx`, add `'mdhStatsSampleSize',` to the `chrome.storage.local.get([…])` list next to `'mdhStagesSampleSize'`. A key missing from that list reads back `undefined` for ever.

Then, next to the `mdhStagesSampleSize` coercion:

```ts
  if (stored.mdhStatsSampleSize != null) {
    store.statsSampleSize.value = store.coerceStatsSampleSize(stored.mdhStatsSampleSize);
  }
```

And next to the `mdhStagesSampleSize` persistence effect:

```ts
  effect(() => {
    chrome.storage.local.set({ mdhStatsSampleSize: store.statsSampleSize.value });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-sampling.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the key to the documented list**

In `CLAUDE.md`, under **Chrome Storage Keys** → **Global prefs**, add `mdhStatsSampleSize` to the list alongside `mdhStages*`.

- [ ] **Step 6: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/store.ts src/mdh/index.tsx tests/mdh-stats-sampling.test.ts CLAUDE.md
```

---

### Task 7: StatsPanel chooses the path and hosts the control

**Files:**
- Modify: `src/mdh/components/StatsPanel.tsx`
- Modify: `src/mdh/components/StatsFieldGrid.tsx` (accept `sampled`, forward it to each card)
- Test: `tests/mdh-stats-panel.test.tsx` (create)

**Interfaces:**
- Consumes: `shouldSample`, `buildSampleReadPipeline`, `STATS_SAMPLE_OPTIONS`, `sampleSizeLabel`, `STATS_EXACT` (Task 1); `computeSampledChecks` (Task 4); `statsSampleSize` (Task 6); `buildFieldProfiles` `analyzed` (Task 5).
- Produces: `StatsSummary` receives `sampled: number | null` (the sample size, or null on an exact run) and `docSize` possibly carrying `min: null` / `max: null`; `StatsFieldGrid` receives `sampled` and passes it through to each card.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-stats-panel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js', () => ({
  aggregate: vi.fn(),
  listIndexes: vi.fn(async () => ({ result: [] })),
}));

import StatsPanel from '../src/mdh/components/StatsPanel.jsx';
import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import { selectedCollection, activePanel, statsSampleSize } from '../src/mdh/store.js';
import { STATS_EXACT } from '../src/mdh/statsPipelines.js';

function pipelinesSent() {
  return vi.mocked(api.aggregate).mock.calls.map((c) => c[1]);
}

function mount() {
  const root = document.createElement('div');
  render(<StatsPanel />, root);
  return root;
}

// A fixed flush races preact's after-paint effects under full-suite load, so
// wait on the condition instead: the run is done once the storage read lands.
// vi.waitFor only retries on a THROW, which is what expect() gives us.
function settle(minCalls = 3) {
  return vi.waitFor(() => expect(vi.mocked(api.aggregate).mock.calls.length).toBeGreaterThanOrEqual(minCalls));
}

describe('StatsPanel path selection', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsSampleSize.value = 5000;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
  });

  it('issues one sampled read instead of the twelve check pipelines above the threshold', async () => {
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{ storageStats: { size: 1, storageSize: 2, avgObjSize: 3, count: 4 } }] };
    });
    mount();
    await settle();
    const samples = pipelinesSent().filter((p) => p[0].$sample);
    // one 200-doc discovery sample, one 5,000-doc analysis sample
    expect(samples.map((p) => p[0].$sample.size).sort((a, b) => a - b)).toEqual([200, 5000]);
    expect(pipelinesSent().some((p) => p[0].$facet || p[1]?.$facet)).toBe(false);
  });

  it('runs the exact pipelines below the threshold', async () => {
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.count) return { result: [{ count: 900 }] };
      return { result: [{}] };
    });
    mount();
    await settle();
    expect(pipelinesSent().some((p) => p.some((st) => st.$facet))).toBe(true);
  });

  it('runs the exact pipelines on the Exact setting whatever the size', async () => {
    statsSampleSize.value = STATS_EXACT;
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.count) return { result: [{ count: 40_000_000 }] };
      return { result: [{}] };
    });
    mount();
    await settle();
    expect(pipelinesSent().some((p) => p.some((st) => st.$facet))).toBe(true);
  });
});

describe('the sample-size control', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsSampleSize.value = 5000;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ count: 10 }] });
  });

  it('offers every option and marks the active one, on every collection size', async () => {
    const root = mount();
    await settle();
    const opts = [...root.querySelectorAll('.stats-sample-seg .view-seg-opt')];
    expect(opts.map((o) => o.textContent)).toEqual(['1k', '5k', '25k', 'Exact']);
    expect(opts.find((o) => o.getAttribute('aria-pressed') === 'true')!.textContent).toBe('5k');
  });

  it('writes the signal and re-runs when a different size is chosen', async () => {
    const root = mount();
    await settle();
    const opts = [...root.querySelectorAll('.stats-sample-seg .view-seg-opt')];
    (opts.find((o) => o.textContent === '25k') as HTMLButtonElement).click();
    expect(statsSampleSize.value).toBe(25000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-panel.test.tsx`
Expected: FAIL — no `.stats-sample-seg` in the document, and the sampled case still sends `$facet` pipelines.

- [ ] **Step 3: Write the implementation**

In `src/mdh/components/StatsPanel.tsx`:

Extend the imports:

```ts
import { selectedCollection, activePanel, error, statsSummary, statsSampleSize } from '../store.js';
import { assembleSampledStats } from '../statsCompute.js';
import {
  FIELD_DISCOVERY_SIZE,
  discoverFieldsWithTotal,
  buildOverviewPipeline,
  buildAllPipelines,
  buildSampleReadPipeline,
  buildStoragePipeline,
  shouldSample,
  sampleSizeLabel,
  STATS_SAMPLE_OPTIONS,
  STATS_CHECKS,
} from '../statsPipelines.js';
```

Add `sampleSize` to the effect's dependency list and record what was analysed. Replace the effect's Phase 2 block (from `// Phase 2: run all checks in parallel` to the end of the `await Promise.allSettled(...)` call) with:

```ts
      // Phase 2. Above the threshold this is ONE sampled read profiled in the
      // browser; below it, the exact server pipelines, unchanged. What decides
      // is shouldSample, and the threshold moves with the control.
      const sampleSize = statsSampleSize.value;
      const sampled = shouldSample(totalDocs, sampleSize);
      setAnalyzed(sampled ? sampleSize : totalDocs);
      setSampledSize(sampled ? sampleSize : null);

      if (sampled) {
        for (const key of STATS_CHECKS) setStatus(key, 'loading');
        try {
          let computed = cache.get(collection, 'stats_sampled');
          if (!computed) {
            const [sampleRes, storageRes] = await Promise.all([
              api.aggregate(collection, buildSampleReadPipeline(discoveredFields, sampleSize)),
              api.aggregate(collection, buildStoragePipeline()),
            ]);
            if (runId !== runIdRef.current) return;
            computed = assembleSampledStats(sampleRes.result || [], discoveredFields, storageRes);
            cache.set(collection, 'stats_sampled', computed);
            for (const key of STATS_CHECKS) cache.set(collection, `stats_${key}`, computed[key]);
          }
          setRaw(computed);
          for (const key of STATS_CHECKS) setStatus(key, 'done');
        } catch (err: any) {
          if (runId !== runIdRef.current) return;
          for (const key of STATS_CHECKS) setStatus(key, { error: err.message });
        }
      } else {
        const pipelines = buildAllPipelines(discoveredFields);
        for (const key of STATS_CHECKS) setStatus(key, 'loading');
        await Promise.allSettled(
          STATS_CHECKS.map(async (key) => {
            const cacheKey = `stats_${key}`;
            try {
              let res = cache.get(collection, cacheKey);
              if (!res) {
                res = await api.aggregate(collection, (pipelines as Record<string, any>)[key]);
                if (runId !== runIdRef.current) return;
                cache.set(collection, cacheKey, res);
              }
              setRaw((prev) => ({ ...prev, [key]: res }));
              setStatus(key, 'done');
            } catch (err: any) {
              if (runId !== runIdRef.current) return;
              setStatus(key, { error: err.message });
            }
          }),
        );
      }
```

Add the two pieces of state beside the existing `useState` calls:

```ts
  const [analyzed, setAnalyzed] = useState(0); // documents the numbers came from
  const [sampledSize, setSampledSize] = useState<number | null>(null); // null on an exact run
```

Change the effect's dependency array to `[selectedCollection.value, activePanel.value, statsSampleSize.value]`.

Pass `analyzed` through and hand `sampled` to the two children:

```ts
  const profiles = buildFieldProfiles({
    fields,
    total: overview?.total || 0,
    analyzed,
    coverage: t.coverage,
```

```tsx
        {overview && (
          <StatsSummary
            health={health}
            components={components}
            total={overview.total}
            fieldCount={overview.fieldCount}
            fieldsTotal={fieldsTotal}
            storage={storage}
            docSize={docSize}
            sampled={sampledSize}
          />
        )}
```

```tsx
        {fields.length > 0 && (
          <StatsFieldGrid profiles={profiles} indexMap={idxMap} sampled={sampledSize} />
        )}
```

Add the control to the toolbar, between the title and the progress indicator. It is always visible: the threshold is `20 × sampleSize`, so whether sampling applies depends on the control's own value, and a control that hides itself cannot express a threshold that moves with it. **[SUPERSEDED]** — the `20 × sampleSize` threshold and the four-option control described here are gone; see spec §13.1–13.2 for the budgeted rule and the Sample/Exact control that replaced them.

```tsx
        <span style="font-size:11px;color:var(--text-secondary)">Sample</span>
        <span class="view-seg stats-sample-seg" role="group" aria-label="Sample size">
          {STATS_SAMPLE_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              class={`view-seg-opt${statsSampleSize.value === n ? ' on' : ''}`}
              aria-pressed={statsSampleSize.value === n}
              onClick={() => {
                // invalidateData clears every stats_* entry, stats_sampled included.
                cache.invalidateData(selectedCollection.value);
                statsSampleSize.value = n;
              }}
            >
              {sampleSizeLabel(n)}
            </button>
          ))}
        </span>
```

Finally, pass `sampled` down in `StatsFieldGrid.tsx` — add `sampled` to its props and forward it to each `<StatsFieldCard … sampled={sampled} />`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-panel.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/components/StatsPanel.tsx src/mdh/components/StatsFieldGrid.tsx tests/mdh-stats-panel.test.tsx
```

---

### Task 8: The info strip replaces the warning

**Files:**
- Modify: `src/mdh/components/StatsSummary.tsx`
- Modify: `src/console/console.css` (beside `.stats-warn`)
- Test: `tests/mdh-stats-cards.test.tsx` (create)

**Interfaces:**
- Consumes: `sampled: number | null` from Task 7.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Create `tests/mdh-stats-cards.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import StatsSummary from '../src/mdh/components/StatsSummary.jsx';

function mount(props: any) {
  const root = document.createElement('div');
  render(<StatsSummary total={4_210_663} fieldCount={50} fieldsTotal={50} {...props} />, root);
  return root;
}

describe('StatsSummary sampling notice', () => {
  it('states the sample and what stayed exact, instead of warning about timeouts', () => {
    const root = mount({ sampled: 5000 });
    const note = root.querySelector('.stats-note')!;
    expect(note.textContent).toContain('5,000');
    expect(note.textContent).toContain('4,210,663');
    expect(note.textContent).toContain('exact');
    expect(root.querySelector('.stats-warn')).toBeNull();
  });

  it('says nothing on an exact run, at any size', () => {
    const root = mount({ sampled: null });
    expect(root.querySelector('.stats-note')).toBeNull();
    expect(root.querySelector('.stats-warn')).toBeNull();
  });
});

describe('StatsSummary document size', () => {
  it('shows the average from storage stats and omits a min/max tooltip it does not have', () => {
    const root = mount({
      sampled: 5000,
      docSize: { count: 10, avg: 812, min: null, max: null, total: 8120 },
    });
    const card = [...root.querySelectorAll('.stats-overview-card')].find((c) =>
      c.textContent!.includes('Avg doc'),
    )!;
    expect(card.textContent).toContain('812 B');
    expect(card.getAttribute('title')).toBeNull();
  });

  it('keeps the min/max tooltip on an exact run', () => {
    const root = mount({
      sampled: null,
      docSize: { count: 10, avg: 812, min: 100, max: 2000, total: 8120 },
    });
    const card = [...root.querySelectorAll('.stats-overview-card')].find((c) =>
      c.textContent!.includes('Avg doc'),
    )!;
    expect(card.getAttribute('title')).toContain('Min:');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-cards.test.tsx`
Expected: FAIL — `.stats-note` is null; the docSize card renders `title="Min: — · Max: —"`.

- [ ] **Step 3: Write the implementation**

In `src/mdh/components/StatsSummary.tsx`:

Delete `const LARGE_COLLECTION_WARN = 100000;`. It is not moved: the threshold is now `20 × sampleSize`, so it is no longer a fixed number. **[SUPERSEDED]** — the threshold is no longer `20 × sampleSize` either; see spec §13.1.

Add `sampled` to the props and type:

```ts
  /** Sample size the field-level numbers came from, or null on an exact run. */
  sampled?: number | null;
```

Replace the trailing warning block:

```tsx
      {sampled != null && (
        <div class="stats-note" style={{ marginTop: '10px' }}>
          Estimated from a random sample of <b>{sampled.toLocaleString()}</b> of{' '}
          {total.toLocaleString()} documents. Document count and storage are exact.
        </div>
      )}
```

Guard the docSize tooltip, which currently formats `min`/`max` unconditionally:

```tsx
              <div
                class="stats-overview-card"
                // `undefined`, not `null`: Preact sets `dom.title = ''` for a
                // null value, which leaves an empty attribute rather than no
                // attribute. Verified empirically during implementation.
                title={
                  docSize.min != null && docSize.max != null
                    ? `Min: ${formatBytes(docSize.min)} · Max: ${formatBytes(docSize.max)}`
                    : undefined
                }
              >
```

Widen the `docSize` prop type so a sampled run type-checks:

```ts
  docSize?: { min: number | null; max: number | null; avg: number } | null;
```

In `src/console/console.css`, directly after the `.stats-warn` rule:

```css
/* Neutral sibling of .stats-warn, for stating what happened rather than
   warning about it. Uses the info token family (7.5:1 in both themes), unlike
   --text-secondary on --bg-card, which measures 4.21:1 at this size. */
.stats-note {
  font-size: 11px;
  color: var(--info-fg);
  background: var(--info-bg);
  border: 1px solid var(--info-border);
  border-radius: var(--radius);
  padding: 6px 10px;
  margin-bottom: 8px;
  line-height: 1.4;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-cards.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/components/StatsSummary.tsx src/console/console.css tests/mdh-stats-cards.test.tsx
```

---

### Task 9: The distinct count on the field card

**Files:**
- Modify: `src/mdh/components/StatsFieldCard.tsx`
- Modify: `src/console/console.css` (`.stats-fcard-meta`)
- Test: `tests/mdh-stats-cards.test.tsx`

**Interfaces:**
- Consumes: `sampled` forwarded by `StatsFieldGrid` (Task 7); `profile.distinct`, which `buildFieldProfiles` already produces.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-stats-cards.test.tsx`:

```tsx
import StatsFieldCard from '../src/mdh/components/StatsFieldCard.jsx';

const profile = {
  field: 'currency',
  total: 4_210_663,
  pct: 100,
  present: 5000,
  nullCount: 0,
  missingCount: 0,
  emptyCount: 0,
  primaryType: 'string',
  types: [{ type: 'string', count: 5000 }],
  isMixed: false,
  distinct: 4812,
  diversityPct: 96,
  topValues: [{ value: 'EUR', count: 2104 }],
  fullyDistinct: false,
  string: null,
  numeric: null,
  date: null,
  sentinel: null,
};

function mountCard(props: any) {
  const root = document.createElement('div');
  render(<StatsFieldCard profile={profile} {...props} />, root);
  return root;
}

describe('StatsFieldCard distinct count', () => {
  it('marks the count as a lower bound and names the sample it came from', () => {
    const meta = mountCard({ sampled: 5000 }).querySelector('.stats-fcard-meta')!;
    expect(meta.textContent).toContain('4,812');
    expect(meta.textContent).toContain('≥'); // the count is a floor: a sample
    expect(meta.textContent).toContain('in 5,000 sampled'); // cannot see a value it did not draw
  });

  it('drops the qualifier on an exact run, because then it is the real count', () => {
    const meta = mountCard({ sampled: null }).querySelector('.stats-fcard-meta')!;
    expect(meta.textContent).toContain('4,812 distinct');
    expect(meta.textContent).not.toContain('≥');
    expect(meta.textContent).not.toContain('sampled');
  });

  it('renders no meta row when there is no count to show', () => {
    const root = document.createElement('div');
    render(<StatsFieldCard profile={{ ...profile, distinct: 0 }} sampled={null} />, root);
    expect(root.querySelector('.stats-fcard-meta')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-cards.test.tsx`
Expected: FAIL — `.stats-fcard-meta` is null.

- [ ] **Step 3: Write the implementation**

In `src/mdh/components/StatsFieldCard.tsx`, add `sampled` to the props and type, and insert the meta row directly after the `stats-fcard-h` header, before the numeric/date mini charts.

`\uXXXX` does not work in JSX text, so `≥` goes through an expression:

```tsx
      {profile.distinct > 0 && (
        <div class="stats-fcard-meta">
          <span>
            {sampled != null ? '≥ ' : ''}
            <b>{profile.distinct.toLocaleString()}</b> distinct
          </span>
          {sampled != null && <span>in {sampled.toLocaleString()} sampled</span>}
        </div>
      )}
```

In `src/console/console.css`, fix the contrast on the revived rule. Measured at 4.21:1 on `--text-secondary` over `--bg-card` at 11px, under the 4.5:1 floor — the same ratio and the same cause as the `ModalFieldLabel` fix in `a9ed60a`, and the same remedy: move to `--text-primary` and keep the hierarchy in weight rather than colour.

```css
.stats-fcard-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text-primary);
  font-family: var(--font-mono);
}
.stats-fcard-meta b {
  font-weight: 600;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-cards.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/components/StatsFieldCard.tsx src/console/console.css tests/mdh-stats-cards.test.tsx
```

---

### Task 10: Prefetch samples too, and stops running twice

**Files:**
- Modify: `src/mdh/prefetch.ts`
- Test: `tests/mdh-stats-sampling.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 4 and 6.
- Produces: `prefetchStats` unchanged in signature; a module-local in-flight map.

- [ ] **Step 1: Write the failing test**

Append to `tests/mdh-stats-sampling.test.ts`:

```ts
import { vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/api.js', () => ({
  aggregate: vi.fn(),
  listIndexes: vi.fn(async () => ({ result: [] })),
  listSearchIndexes: vi.fn(async () => []),
}));

import { prefetchForPanel } from '../src/mdh/prefetch.js';
import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';

describe('prefetchStats', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsSampleSize.value = 5000;
    vi.mocked(api.aggregate).mockReset();
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{ storageStats: {} }] };
    });
  });

  it('uses the sampled read above the threshold, not the twelve check pipelines', async () => {
    await prefetchForPanel('example', 'stats');
    const sent = vi.mocked(api.aggregate).mock.calls.map((c) => c[1]);
    expect(sent.some((p) => p.some((st: any) => st.$facet))).toBe(false);
    expect(sent.filter((p) => p[0].$sample).map((p) => p[0].$sample.size)).toContain(5000);
  });

  it('does the work once when the panel and the prefetch race for it', async () => {
    // Both check the cache, both miss, and before this fix both fired the whole
    // suite — the concurrency the 2026-06 probe identified as the timeout cause.
    await Promise.all([prefetchForPanel('example', 'stats'), prefetchForPanel('example', 'stats')]);
    const analysisReads = vi
      .mocked(api.aggregate)
      .mock.calls.map((c) => c[1])
      .filter((p) => p[0].$sample && p[0].$sample.size === 5000);
    expect(analysisReads).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-stats-sampling.test.ts`
Expected: FAIL — `$facet` pipelines still sent, and two analysis reads instead of one.

- [ ] **Step 3: Write the implementation**

In `src/mdh/prefetch.ts`, extend the imports:

```ts
import {
  FIELD_DISCOVERY_SIZE,
  discoverFieldsWithTotal,
  STATS_CHECKS,
  buildAllPipelines,
  buildSampleReadPipeline,
  buildStoragePipeline,
  shouldSample,
} from './statsPipelines.js';
import { assembleSampledStats } from './statsCompute.js';
import { statsSampleSize } from './store.js';
```

Add the in-flight map above `prefetchStats`. Keyed by collection AND sample size, so a control change starts a fresh run rather than joining a stale one:

```ts
// StatsPanel and prefetchStats both check the cache, both miss, and both used to
// fire the whole suite — the concurrency the 2026-06 probe identified as the
// real cause of the Stats timeouts. One in-flight promise per (collection,
// sample size) makes the second caller await the first.
const statsInFlight = new Map<string, Promise<void>>();
```

Replace the body of `prefetchStats` with a thin wrapper around the existing work:

```ts
async function prefetchStats(collection: string, signal?: AbortSignal) {
  const key = `${collection}::${statsSampleSize.value}`;
  const running = statsInFlight.get(key);
  if (running) return running;
  const p = runPrefetchStats(collection, signal).finally(() => statsInFlight.delete(key));
  statsInFlight.set(key, p);
  return p;
}

async function runPrefetchStats(collection: string, signal?: AbortSignal) {
  let fields = cache.get(collection, 'statsFields');
  if (!fields) {
    try {
      const sample = await api.aggregate(
        collection,
        [{ $sample: { size: FIELD_DISCOVERY_SIZE } }],
        { signal },
      );
      if (signal?.aborted) return;
      const discovered = discoverFieldsWithTotal(sample.result || []);
      fields = discovered.fields;
      if (fields.length > 0) {
        cache.set(collection, 'statsFields', fields);
        cache.set(collection, 'statsFieldsTotal', discovered.total);
      }
    } catch (err) {
      if (!isAbort(err)) return;
      return;
    }
  }
  if (!fields || fields.length === 0 || signal?.aborted) return;

  // prefetchTotalCount already caches this and is a no-op when it is cached —
  // do not inline a second $collStats call beside it.
  await prefetchTotalCount(collection, signal);
  if (signal?.aborted) return;
  const total = cache.get(collection, 'totalCount');
  if (total === null) return;

  const sampleSize = statsSampleSize.value;
  if (shouldSample(total, sampleSize)) {
    if (cache.get(collection, 'stats_sampled') !== null) return;
    try {
      const [sampleRes, storageRes] = await Promise.all([
        api.aggregate(collection, buildSampleReadPipeline(fields, sampleSize), { signal }),
        api.aggregate(collection, buildStoragePipeline(), { signal }),
      ]);
      if (signal?.aborted) return;
      const computed = assembleSampledStats(sampleRes.result || [], fields, storageRes);
      cache.set(collection, 'stats_sampled', computed);
      for (const key of STATS_CHECKS) cache.set(collection, `stats_${key}`, computed[key]);
    } catch (err) {
      if (!isAbort(err)) {
        /* silent */
      }
      return;
    }
  } else {
    const pipelines: Record<string, any> = buildAllPipelines(fields);
    await Promise.allSettled(
      STATS_CHECKS.map(async (key) => {
        if (signal?.aborted) return;
        const cacheKey = `stats_${key}`;
        if (cache.get(collection, cacheKey) !== null) return;
        try {
          const res = await api.aggregate(collection, pipelines[key], { signal });
          if (signal?.aborted) return;
          cache.set(collection, cacheKey, res);
        } catch (err) {
          if (!isAbort(err)) {
            /* silent */
          }
        }
      }),
    );
  }
  if (signal?.aborted) return;
  updateStatsSummary(collection);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-stats-sampling.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-test the dedupe guard**

A guard that cannot fail is not a guard. Temporarily delete the `if (running) return running;` line, re-run `npx vitest run tests/mdh-stats-sampling.test.ts`, and confirm the race test fails with `expected length 2 to be 1`. Restore the line and confirm it passes again.

- [ ] **Step 6: Gate and stage**

```bash
npm run typecheck && npm test && npm run format:check
git add src/mdh/prefetch.ts tests/mdh-stats-sampling.test.ts
```

---

### Task 11: Verify it in a real browser

jsdom has no layout and no network, so nothing above this task proves the tab is fast, that the transfer is affordable, or that the info strip and meta row read correctly at real sizes. Spec §2 assumption 4 and §9.6 make this a completion criterion, not a nice-to-have. The 2026-06 attempt at this design was reverted before it ever ran in a browser.

**Files:** none. This task produces measurements and, if they contradict the design, a spec amendment.

- [ ] **Step 1: Build**

```bash
npm run build
```

`dist/` is what the browser runs; `src/` is what the tests ran.

- [ ] **Step 2: Load the extension and open the Console**

Use an **internal Rossum organisation only** — never a customer organisation. Follow the dogfooding recipe: launch with `--profile "Profile 1" --extension dist`, read the extension id from `chrome://extensions`, and stage the Console auth browser-side so no token enters the transcript.

- [ ] **Step 3: Measure the sampled path**

On a collection above the threshold, open Stats and record:

1. Wall-clock time from opening the tab to the field grid painting.
2. The transfer size of the `$sample` response, from the Network panel, at **5,000 and at 25,000** — 25,000 is the setting at risk, not the default.
3. That exactly one analysis read is issued, not two (the Task 10 dedupe, in the real double-run the unit test only simulates).

- [ ] **Step 4: Confirm the sampling rule at the boundary**

Spec §2 assumption 1 — `$sample`'s fast path was never tested at the 5% boundary on Data Storage. On one collection, compare the analysis read's duration at a size that samples against one that does not, and confirm the sampled read is not slower. If it is, the divisor is wrong and the spec needs amending before this ships.

- [ ] **Step 5: Confirm the numeric wire format**

Spec §2 assumption 2. In the Network panel, inspect a sampled response for a collection holding large integers or decimals and confirm whether they arrive as bare JSON numbers or as `{"$numberLong": …}` / `{"$numberDecimal": …}`. `bsonType` handles both; this step confirms which is real and closes the assumption.

- [ ] **Step 6: Read the interface at real sizes**

Toggle the OS between light and dark. Confirm the info strip and the distinct meta row are legible in both, that the toolbar control does not wrap at a narrow Console width, and that switching sample size re-runs and repaints without stale numbers.

- [ ] **Step 7: Record the results**

Append a "Verified in the browser" section to the spec with the measured numbers and the date, and close or amend each of the four assumptions in §2. An assumption that could not be checked is recorded as still open, not quietly dropped.

- [ ] **Step 8: Stage**

```bash
git add docs/superpowers/specs/2026-09-22-mdh-stats-sampling-design.md
```

Then report the measurements and ask the owner whether to commit. The whole run is one commit; do not split it.

---

## Notes for the executor

- **`prefetchAll` is unchanged on purpose.** It keeps running the stats path for every selected collection, now as one sampled query instead of twelve — that is what keeps the tab-bar health dot working everywhere, and it was an explicit owner decision.
- **The exact path must stay byte-identical.** If a test in `tests/mdh-stats-view.test.ts` or `tests/mdh-stats-summary.test.ts` needs editing for any reason other than Task 5's new `analyzed` cases, the raw-shape contract has been broken — stop and re-read spec §5.
- **Spec §9.1's differential criterion is met across two places**, not one file: Task 3's last test runs `transformStatsResults` over the client output for the four health-score checks, and Task 4 asserts each of the six field-detail transforms reads it. If you add a recorded server response to diff against, diff the TRANSFORMED output — the raw shapes differ by design on numeric subtypes (spec §5).
- **Appended test imports go in the top import block.** Tasks 3, 4, 9 and 10 add tests to a file an earlier task created. ESM hoists imports wherever they sit, but put them with the existing block — a mid-file `import` reads as an accident.
- **`MAX_FIELDS` stays at 50.** Client-side compute removes the server-side reason for the cap, but transfer is linear in field count. Out of scope, deliberately.
