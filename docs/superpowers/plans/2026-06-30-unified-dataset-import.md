# Unified Dataset Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MDH app's two inconsistent import families with one unified Import wizard that does Insert / Update / Replace across all five file formats, with configurable match keys, a live "what-will-happen" plan, progress, and cancellation.

**Architecture:** New pure logic modules (`importPlan.js` for the match plan, `runImport.js` for the executor) sit under a single `ImportWizard.jsx` driven by a pluggable per-format parser registry (`formats/`). Update/Replace by arbitrary key run per-row through a concurrency worker pool; `_id`-keyed work reuses the existing batched `runChunkedInsert` / `runChunkedOverwrite`. Upsert is emulated from the plan split. The four old per-format wizards and the dead Update/Replace panels are deleted in a final switchover task.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE, classic JSX pragma `h`), Vitest + jsdom, Rossum Data Storage REST API (`/svc/data-storage`).

## Global Constraints

- **Build:** esbuild only, no transpilation beyond JSX. Classic pragma: `h` / `Fragment`. Run `npm run build` after UI changes to verify the bundle.
- **Tests:** Vitest. Files live in `tests/**/*.test.js`. DOM tests start with `// @vitest-environment jsdom`. Mock the API with `vi.mock('../src/mdh/api.js')` then `import * as api`. Components are mounted via `h(Component, props)` + Preact `render` (never raw JSX in `.test.js`). Run a test file: `npx vitest run tests/<name>.test.js`. Full suite: `npm test`.
- **JSX unicode:** `\uXXXX` does NOT work in JSX text/attributes — use `{'…'}`, the literal glyph, or an HTML entity. Fine inside template/regular strings.
- **No `bulk_write`:** documented-unreliable on this Data Storage backend (returns success without effect). Never use it. Use delete+insert and per-row ops.
- **EJSON-on-input:** `{$oid}` / `{$date}` in request bodies become real BSON types. A 24-hex-char string `_id` must be coerced to `{$oid}` (existing `normalizeDocId`).
- **Backward compatibility:** keep the signatures of `importFile.js` primitives (`runChunkedInsert`, `runChunkedOverwrite`, `dedupeById`, `analyzeDocs`, `normalizeDocId`, `stableKey`, `findExistingIds`) and the parser modules (`csv.js`, `xlsx.js`, `xml.js`, `ndjson.js`). `runChunkedOverwrite` must keep its exact legacy "overwrite" behavior.
- **Customer-data safety:** never write to a real/customer collection during development. Live API probes (Task 9) run ONLY against a throwaway collection name, ONLY after explicit user confirmation. Never log or paste customer data or names.
- **Commits:** the project owner defers commits. Treat every "Commit" step as **"stage + checkpoint for review"** — do NOT run `git commit` unless the user explicitly asks. Stay on `master`; no branches/worktrees.

---

## File Structure

**New:**
- `src/mdh/importPlan.js` — pure: key extraction, in-file analysis, probe-pipeline builder, plan computation.
- `src/mdh/runImport.js` — executor: collection probe (network) + mode dispatch (chunked insert/overwrite reuse + per-row concurrency pool for update/replace).
- `src/mdh/formats/index.js` — format registry (`FORMATS`, `getFormat`).
- `src/mdh/formats/json.js`, `jsonl.js` — parse-only entries (no Configure UI).
- `src/mdh/formats/csv.jsx`, `xlsx.jsx`, `xml.jsx` — parse + `ConfigureControls` (migrated from old wizards).
- `src/mdh/components/ImportControls.jsx` — shared presentational bits (`Segmented`, `Toggle`, `CsvPreview`, `PreviewValue`) relocated out of `CsvImportWizard.jsx`.
- `src/mdh/components/ImportWizard.jsx` — the unified wizard (stage machine).
- `src/mdh/components/ImportConfirm.jsx` — the mode + match-key + live-plan CONFIRM stage.

**Modified:**
- `src/mdh/api.js` — optional `options` passthrough on `updateOne` / `replaceOne`.
- `src/mdh/components/ImportStages.jsx` — add mode-aware `ImportProgress` / `ImportSummary`; keep `formatBytes` exported.
- `src/mdh/components/DataOperations.jsx` — keep inline `InsertPanel`; replace `openDataOperations` with an `openImport(format, mode, onSuccess, fieldsFn)` helper; remove dead `UpdatePanel` / `ReplacePanel` / `FileInput` / `MatchFields`.
- `src/mdh/components/RecordList.jsx` — `Insert ▾` split button → `Import ▾`.
- `src/mdh/components/DataPanel.jsx` — reroute `insert*` actions to `openImport`.

**Deleted (Task 8):**
- `src/mdh/components/InsertFileWizard.jsx`, `CsvImportWizard.jsx`, `XlsxImportWizard.jsx`, `XmlImportWizard.jsx`.

**Tests new:** `tests/mdh-import-plan.test.js`, `tests/mdh-run-import.test.js`, `tests/mdh-formats.test.js`, `tests/mdh-import-confirm.test.js`, `tests/mdh-import-wizard.test.js`.
**Tests modified/retired (Task 8):** `tests/mdh-insert-file.test.js`, `mdh-csv-wizard.test.js`, `mdh-xlsx-wizard.test.js`, `mdh-xml-wizard.test.js`, `mdh-csv-routing.test.js`, `mdh-import-stages.test.js`.
**Tests untouched:** `tests/mdh-import-file.test.js`, `mdh-csv.test.js`, `mdh-xlsx.test.js`, `mdh-xml.test.js`, `mdh-ndjson.test.js`.

---

## Task 1: API `options` passthrough (additive)

**Files:**
- Modify: `src/mdh/api.js:224-242`
- Test: `tests/mdh-api.test.js`

**Interfaces:**
- Produces: `updateOne(collectionName, filter, update, options?)`, `updateMany(collectionName, filter, update, options?)`, `replaceOne(collectionName, filter, replacement, options?)` — `options` is omitted from the request body when not provided, so existing callers and request shapes are unchanged.

- [ ] **Step 1: Write the failing test** — append to `tests/mdh-api.test.js`:

```js
describe('write options passthrough', () => {
  beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(jsonResponse({ result: {} })); });

  it('omits options when not passed (back-compat body shape)', async () => {
    await api.updateOne('c', { _id: 1 }, { $set: { a: 1 } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ collectionName: 'c', filter: { _id: 1 }, update: { $set: { a: 1 } } });
    expect('options' in body).toBe(false);
  });

  it('includes options.upsert when passed', async () => {
    await api.replaceOne('c', { _id: 1 }, { a: 1 }, { upsert: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options).toEqual({ upsert: true });
  });
});
```

> Match the existing `tests/mdh-api.test.js` harness for `fetchMock` / `jsonResponse`. If those helpers have different names there, reuse whatever that file already defines (read its top); do not introduce a second fetch-mock style.

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run tests/mdh-api.test.js -t "options passthrough"`
Expected: FAIL — `body.options` is `undefined`.

- [ ] **Step 3: Implement** — edit `src/mdh/api.js`:

```js
export function updateOne(collectionName, filter, update, options) {
  const body = { collectionName, filter, update };
  if (options) body.options = options;
  return post('/data/update_one', body);
}

export function updateMany(collectionName, filter, update, options) {
  const body = { collectionName, filter, update };
  if (options) body.options = options;
  return post('/data/update_many', body);
}

export function replaceOne(collectionName, filter, replacement, options) {
  const body = { collectionName, filter, replacement };
  if (options) body.options = options;
  return post('/data/replace_one', body);
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run tests/mdh-api.test.js`
Expected: PASS (all existing api tests still green).

- [ ] **Step 5: Commit** (checkpoint — see Global Constraints)

```bash
git add src/mdh/api.js tests/mdh-api.test.js
git commit -m "feat(mdh): optional options passthrough on update/replace api"
```

---

## Task 2: `importPlan.js` — pure match-plan logic

**Files:**
- Create: `src/mdh/importPlan.js`
- Test: `tests/mdh-import-plan.test.js`

**Interfaces:**
- Consumes: `stableKey`, `normalizeDocId` from `./importFile.js`.
- Produces:
  - `keyValue(doc, keys)` → for a single key returns the raw value; for multiple keys returns `{ [k]: doc[k] }` for present keys. Returns `undefined` if ANY key field is missing.
  - `keyKeyOf(doc, keys)` → `string | null` — `stableKey(keyValue)` or `null` when a key field is missing.
  - `analyzeFileKeys(docs, keys)` → `{ inFileDupes: [{ keyKey, count }], missingKeyCount }`.
  - `buildProbePipeline(keys, batch)` → MongoDB aggregation stages (array) for one batch of file docs.
  - `MATCH_BATCH` (number) = 1000.
  - `computePlan({ docs, keys, groups, upsert })` → `{ matched, unmatched, missingKey, ambiguous, inFileDupes, blocked, counts }` (shapes below).

> **Composite-key strategy (realizes the spec's "stable synthetic serialization"):** the probe groups existing docs by the *typed key object* and the client joins file rows to groups via `stableKey` — avoiding any string-serialization type-mismatch. Single-field keys use `$in`; composite keys use a batched `$or` of `$and`s. `_id` key values are coerced to `{$oid}` for 24-hex strings (via `normalizeDocId`-style logic) so they match stored ObjectIds.

- [ ] **Step 1: Write failing tests** — `tests/mdh-import-plan.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  keyValue, keyKeyOf, analyzeFileKeys, buildProbePipeline, computePlan, MATCH_BATCH,
} from '../src/mdh/importPlan.js';
import { stableKey } from '../src/mdh/importFile.js';

describe('keyValue / keyKeyOf', () => {
  it('single key returns the raw value', () => {
    expect(keyValue({ code: 'A', x: 1 }, ['code'])).toBe('A');
  });
  it('composite key returns an object of present fields', () => {
    expect(keyValue({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toEqual({ a: 1, b: 2 });
  });
  it('returns undefined when any key field is missing', () => {
    expect(keyValue({ a: 1 }, ['a', 'b'])).toBeUndefined();
    expect(keyKeyOf({ a: 1 }, ['a', 'b'])).toBeNull();
  });
  it('keyKeyOf is order-independent for composite keys', () => {
    expect(keyKeyOf({ a: 1, b: 2 }, ['a', 'b'])).toBe(keyKeyOf({ b: 2, a: 1 }, ['b', 'a']));
  });
});

describe('analyzeFileKeys', () => {
  it('detects in-file duplicate key tuples and counts missing-key rows', () => {
    const docs = [{ code: 'A' }, { code: 'B' }, { code: 'A' }, { other: 1 }];
    const r = analyzeFileKeys(docs, ['code']);
    expect(r.inFileDupes).toEqual([{ keyKey: stableKey('A'), count: 2 }]);
    expect(r.missingKeyCount).toBe(1);
  });
});

describe('buildProbePipeline', () => {
  it('single-field key uses $in + $group with ids and count', () => {
    const stages = buildProbePipeline(['code'], [{ code: 'A' }, { code: 'B' }]);
    expect(stages[0]).toEqual({ $match: { code: { $in: ['A', 'B'] } } });
    expect(stages[1]).toEqual({ $group: { _id: '$code', ids: { $push: '$_id' }, count: { $sum: 1 } } });
  });
  it('coerces a 24-hex _id key value to {$oid} in the $in', () => {
    const hex = 'a'.repeat(24);
    const stages = buildProbePipeline(['_id'], [{ _id: hex }]);
    expect(stages[0]).toEqual({ $match: { _id: { $in: [{ $oid: hex }] } } });
  });
  it('composite key uses $or of $and + $group by key object', () => {
    const stages = buildProbePipeline(['a', 'b'], [{ a: 1, b: 2 }]);
    expect(stages[0]).toEqual({ $match: { $or: [{ $and: [{ a: 1 }, { b: 2 }] }] } });
    expect(stages[1]).toEqual({ $group: { _id: { a: '$a', b: '$b' }, ids: { $push: '$_id' }, count: { $sum: 1 } } });
  });
  it('skips rows missing a key field', () => {
    const stages = buildProbePipeline(['code'], [{ code: 'A' }, { nope: 1 }]);
    expect(stages[0]).toEqual({ $match: { code: { $in: ['A'] } } });
  });
});

describe('computePlan', () => {
  const docs = [
    { code: 'A', v: 1 },   // matches 1 existing -> matched
    { code: 'B', v: 2 },   // matches 0 -> unmatched
    { code: 'C', v: 3 },   // matches 2 existing -> ambiguous (block)
    { v: 4 },              // missing key
  ];
  const groups = new Map([
    [stableKey('A'), { ids: ['id-A'], count: 1 }],
    [stableKey('C'), { ids: ['id-C1', 'id-C2'], count: 2 }],
  ]);

  it('splits matched / unmatched / ambiguous / missingKey and blocks on ambiguity', () => {
    const plan = computePlan({ docs, keys: ['code'], groups, upsert: false });
    expect(plan.matched).toEqual([{ doc: docs[0], _id: 'id-A' }]);
    expect(plan.unmatched).toEqual([docs[1]]);
    expect(plan.missingKey).toEqual([docs[3]]);
    expect(plan.ambiguous).toEqual([{ keyKey: stableKey('C'), count: 2 }]);
    expect(plan.blocked).toBe(true);
  });

  it('upsert routes unmatched + missingKey to insert; non-upsert skips them', () => {
    const clean = [docs[0], docs[1], docs[3]];
    const g = new Map([[stableKey('A'), { ids: ['id-A'], count: 1 }]]);
    const off = computePlan({ docs: clean, keys: ['code'], groups: g, upsert: false });
    expect(off.counts).toMatchObject({ willApply: 1, willInsert: 0, willSkip: 2, blocked: false });
    const on = computePlan({ docs: clean, keys: ['code'], groups: g, upsert: true });
    expect(on.counts).toMatchObject({ willApply: 1, willInsert: 2, willSkip: 0, blocked: false });
  });

  it('blocks on in-file duplicate keys even with no ambiguity', () => {
    const dupDocs = [{ code: 'A' }, { code: 'A' }];
    const g = new Map();
    const plan = computePlan({ docs: dupDocs, keys: ['code'], groups: g, upsert: true });
    expect(plan.inFileDupes.length).toBe(1);
    expect(plan.blocked).toBe(true);
  });
});

describe('MATCH_BATCH', () => {
  it('is 1000', () => { expect(MATCH_BATCH).toBe(1000); });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-plan.test.js` → module not found.

- [ ] **Step 3: Implement** — `src/mdh/importPlan.js`:

```js
import { stableKey, normalizeDocId } from './importFile.js';

// One batch of file keys per probe aggregation. Bounded so the $in / $or stays
// within request + 120s aggregate limits.
export const MATCH_BATCH = 1000;

const OBJECTID_RE = /^[0-9a-fA-F]{24}$/;

function hasField(doc, k) {
  return doc !== null && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, k);
}

// Coerce a probe key VALUE the same way insert coerces _id, so a 24-hex string
// _id in the file matches the stored ObjectId (EJSON-on-input). Only applied to
// the `_id` field; other fields are matched as-stored.
function coerceKeyValue(field, value) {
  if (field === '_id' && typeof value === 'string' && OBJECTID_RE.test(value)) return { $oid: value };
  return value;
}

// Single key -> raw value; composite -> object of present fields. undefined if
// ANY key field is absent (such a row cannot be matched).
export function keyValue(doc, keys) {
  if (keys.length === 1) {
    return hasField(doc, keys[0]) ? doc[keys[0]] : undefined;
  }
  const out = {};
  for (const k of keys) {
    if (!hasField(doc, k)) return undefined;
    out[k] = doc[k];
  }
  return out;
}

export function keyKeyOf(doc, keys) {
  const v = keyValue(doc, keys);
  return v === undefined ? null : stableKey(v);
}

export function analyzeFileKeys(docs, keys) {
  const counts = new Map();
  let missingKeyCount = 0;
  for (const d of docs) {
    const kk = keyKeyOf(d, keys);
    if (kk === null) { missingKeyCount++; continue; }
    counts.set(kk, (counts.get(kk) || 0) + 1);
  }
  const inFileDupes = [];
  for (const [keyKey, count] of counts) if (count > 1) inFileDupes.push({ keyKey, count });
  return { inFileDupes, missingKeyCount };
}

// Aggregation stages probing one batch of file docs against the collection.
export function buildProbePipeline(keys, batch) {
  if (keys.length === 1) {
    const field = keys[0];
    const values = [];
    const seen = new Set();
    for (const d of batch) {
      if (!hasField(d, field)) continue;
      const v = coerceKeyValue(field, d[field]);
      const k = stableKey(v);
      if (seen.has(k)) continue;
      seen.add(k);
      values.push(v);
    }
    return [
      { $match: { [field]: { $in: values } } },
      { $group: { _id: `$${field}`, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    ];
  }
  const or = [];
  const seen = new Set();
  for (const d of batch) {
    const kv = keyValue(d, keys);
    if (kv === undefined) continue;
    const k = stableKey(kv);
    if (seen.has(k)) continue;
    seen.add(k);
    or.push({ $and: keys.map((kk) => ({ [kk]: coerceKeyValue(kk, d[kk]) })) });
  }
  const groupId = {};
  for (const kk of keys) groupId[kk] = `$${kk}`;
  return [
    { $match: { $or: or } },
    { $group: { _id: groupId, ids: { $push: '$_id' }, count: { $sum: 1 } } },
  ];
}

// Join file docs to probe groups (Map keyKey -> { ids, count }) and bucket them.
export function computePlan({ docs, keys, groups, upsert }) {
  const matched = [];
  const unmatched = [];
  const missingKey = [];
  const ambiguousMap = new Map();

  for (const doc of docs) {
    const kk = keyKeyOf(doc, keys);
    if (kk === null) { missingKey.push(doc); continue; }
    const g = groups.get(kk);
    if (!g || g.count === 0) { unmatched.push(doc); continue; }
    if (g.count > 1) { ambiguousMap.set(kk, g.count); continue; }
    matched.push({ doc, _id: g.ids[0] });
  }

  const { inFileDupes } = analyzeFileKeys(docs, keys);
  const ambiguous = [...ambiguousMap].map(([keyKey, count]) => ({ keyKey, count }));
  const blocked = ambiguous.length > 0 || inFileDupes.length > 0;

  const insertCount = upsert ? unmatched.length + missingKey.length : 0;
  const skipCount = upsert ? 0 : unmatched.length + missingKey.length;

  return {
    matched, unmatched, missingKey, ambiguous, inFileDupes, blocked,
    counts: {
      willApply: matched.length,   // updated or replaced (mode decides the verb)
      willInsert: insertCount,
      willSkip: skipCount,
      ambiguous: ambiguous.length,
      blocked,
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-import-plan.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/mdh/importPlan.js tests/mdh-import-plan.test.js
git commit -m "feat(mdh): pure import-plan logic (keys, probe pipeline, plan)"
```

---

## Task 3: `runImport.js` — collection probe + mode executor

**Files:**
- Create: `src/mdh/runImport.js`
- Test: `tests/mdh-run-import.test.js`

**Interfaces:**
- Consumes: `* as api` from `./api.js`; `runChunkedInsert`, `runChunkedOverwrite`, `dedupeById`, `normalizeDocId` from `./importFile.js`; `buildProbePipeline`, `computePlan`, `keyKeyOf`, `MATCH_BATCH` from `./importPlan.js`; `stableKey` from `./importFile.js`.
- Produces:
  - `buildUpdateSet(doc, keys)` → object: `doc` minus key fields minus `_id` (the `$set` payload).
  - `buildReplacement(doc)` → `doc` minus `_id`.
  - `isIdKey(keys)` → boolean (`keys.length === 1 && keys[0] === '_id'`).
  - `probeCollection(collection, docs, keys, { signal, onProgress })` → `Map(keyKey -> { ids, count })` (merges batched probe results).
  - `executeImport(collection, { mode, keys, upsert, docs, plan, batchSize?, concurrency?, signal, onProgress })` → `{ kind, applied, inserted, deleted, skipped, failedBatches, cancelled }`.
    - `mode === 'insert'` → `runChunkedInsert`; result `{ kind:'insert', inserted, ... }`.
    - `mode === 'replace' && isIdKey(keys) && upsert` → `runChunkedOverwrite` (legacy fast path); `{ kind:'overwrite', deleted, inserted }`.
    - else (`update`/`replace`) → per-row pool over `plan.matched` (filter `{_id}`, `update_one`/`replace_one`) + `runChunkedInsert` of `[...plan.unmatched, ...plan.missingKey]` when `upsert`.

- [ ] **Step 1: Write failing tests** — `tests/mdh-run-import.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import {
  buildUpdateSet, buildReplacement, isIdKey, probeCollection, executeImport,
} from '../src/mdh/runImport.js';
import { stableKey } from '../src/mdh/importFile.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('pure builders', () => {
  it('buildUpdateSet drops key fields and _id', () => {
    expect(buildUpdateSet({ _id: 'x', code: 'A', name: 'n', qty: 5 }, ['code']))
      .toEqual({ name: 'n', qty: 5 });
  });
  it('buildReplacement drops only _id', () => {
    expect(buildReplacement({ _id: 'x', code: 'A', name: 'n' })).toEqual({ code: 'A', name: 'n' });
  });
  it('isIdKey is true only for the single _id key', () => {
    expect(isIdKey(['_id'])).toBe(true);
    expect(isIdKey(['code'])).toBe(false);
    expect(isIdKey(['_id', 'code'])).toBe(false);
  });
});

describe('probeCollection', () => {
  it('runs batched aggregations and merges groups keyed by stableKey', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [
      { _id: 'A', ids: ['id-A'], count: 1 },
      { _id: 'C', ids: ['c1', 'c2'], count: 2 },
    ] });
    const groups = await probeCollection('vendors', [{ code: 'A' }, { code: 'C' }], ['code'], {});
    expect(groups.get(stableKey('A'))).toEqual({ ids: ['id-A'], count: 1 });
    expect(groups.get(stableKey('C'))).toEqual({ ids: ['c1', 'c2'], count: 2 });
  });
});

describe('executeImport — update by arbitrary key', () => {
  it('calls update_one by matched _id with $set minus keys/_id; skips non-matches when upsert off', async () => {
    api.updateOne.mockResolvedValue({ result: { modified_count: 1 } });
    const plan = {
      matched: [{ doc: { code: 'A', name: 'n' }, _id: 'id-A' }],
      unmatched: [{ code: 'B', name: 'm' }],
      missingKey: [],
    };
    const res = await executeImport('vendors', { mode: 'update', keys: ['code'], upsert: false, docs: [], plan });
    expect(api.updateOne).toHaveBeenCalledWith('vendors', { _id: 'id-A' }, { $set: { name: 'n' } });
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(1);
    expect(api.insertMany).not.toHaveBeenCalled();
  });

  it('upsert inserts unmatched + missingKey via chunked insert', async () => {
    api.updateOne.mockResolvedValue({ result: { modified_count: 1 } });
    api.insertMany.mockResolvedValue({ result: { inserted_ids: ['x', 'y'] } });
    const plan = {
      matched: [{ doc: { code: 'A', name: 'n' }, _id: 'id-A' }],
      unmatched: [{ code: 'B' }],
      missingKey: [{ name: 'orphan' }],
    };
    const res = await executeImport('vendors', { mode: 'update', keys: ['code'], upsert: true, docs: [], plan });
    expect(res.applied).toBe(1);
    expect(res.inserted).toBe(2);
    expect(api.insertMany).toHaveBeenCalledTimes(1);
  });
});

describe('executeImport — replace fast path', () => {
  it('replace + _id key + upsert delegates to runChunkedOverwrite (delete+insert)', async () => {
    api.deleteMany.mockResolvedValue({ result: { deleted_count: 1 } });
    api.insertMany.mockResolvedValue({ result: { inserted_ids: ['1'] } });
    const docs = [{ _id: '1', a: 1 }];
    const res = await executeImport('c', { mode: 'replace', keys: ['_id'], upsert: true, docs, plan: null });
    expect(res.kind).toBe('overwrite');
    expect(api.deleteMany).toHaveBeenCalled();
    expect(api.insertMany).toHaveBeenCalled();
  });

  it('replace by arbitrary key uses replace_one by matched _id, replacement minus _id', async () => {
    api.replaceOne.mockResolvedValue({ result: { modified_count: 1 } });
    const plan = { matched: [{ doc: { _id: 'old', code: 'A', name: 'n' }, _id: 'id-A' }], unmatched: [], missingKey: [] };
    const res = await executeImport('c', { mode: 'replace', keys: ['code'], upsert: false, docs: [], plan });
    expect(api.replaceOne).toHaveBeenCalledWith('c', { _id: 'id-A' }, { code: 'A', name: 'n' });
    expect(res.applied).toBe(1);
  });
});

describe('executeImport — insert mode', () => {
  it('delegates to chunked insert', async () => {
    api.insertMany.mockResolvedValue({ result: { inserted_ids: ['1', '2'] } });
    const res = await executeImport('c', { mode: 'insert', keys: [], upsert: false, docs: [{ a: 1 }, { a: 2 }], plan: null });
    expect(res.kind).toBe('insert');
    expect(res.inserted).toBe(2);
  });
});

describe('executeImport — cancellation', () => {
  it('stops the per-row pool when the signal aborts', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    api.updateOne.mockImplementation(async () => { calls++; if (calls === 1) ctrl.abort(); return { result: {} }; });
    const matched = Array.from({ length: 50 }, (_, i) => ({ doc: { code: String(i) }, _id: `id-${i}` }));
    const res = await executeImport('c', { mode: 'update', keys: ['code'], upsert: false, docs: [], plan: { matched, unmatched: [], missingKey: [] }, signal: ctrl.signal });
    expect(res.cancelled).toBe(true);
    expect(calls).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-run-import.test.js`

- [ ] **Step 3: Implement** — `src/mdh/runImport.js`:

```js
import * as api from './api.js';
import {
  runChunkedInsert, runChunkedOverwrite, dedupeById, normalizeDocId, stableKey,
} from './importFile.js';
import { buildProbePipeline, MATCH_BATCH } from './importPlan.js';
import { BATCH_SIZE, CONCURRENCY } from './downloadCollection.js';

export function isIdKey(keys) {
  return keys.length === 1 && keys[0] === '_id';
}

export function buildUpdateSet(doc, keys) {
  const out = {};
  const drop = new Set([...keys, '_id']);
  for (const k of Object.keys(doc)) if (!drop.has(k)) out[k] = doc[k];
  return out;
}

export function buildReplacement(doc) {
  const out = { ...doc };
  delete out._id;
  return out;
}

// Group existing docs by their key, keyed by stableKey(group._id). Batched so a
// huge file stays within request/aggregate limits; cancellable; reports progress
// as { phase:'analyze', processed, total }.
export async function probeCollection(collection, docs, keys, { signal, onProgress } = {}) {
  const groups = new Map();
  for (let i = 0; i < docs.length; i += MATCH_BATCH) {
    if (signal?.aborted) break;
    const batch = docs.slice(i, i + MATCH_BATCH);
    const stages = buildProbePipeline(keys, batch);
    // Empty $in / $or means nothing in this batch carries the key — skip the call.
    const m = stages[0].$match;
    const empty = (m.$or && m.$or.length === 0) || (keys.length === 1 && m[keys[0]].$in.length === 0);
    if (!empty) {
      const res = await api.aggregate(collection, stages, { signal });
      for (const row of (res.result || [])) {
        groups.set(stableKey(row._id), { ids: row.ids || [], count: row.count || 0 });
      }
    }
    onProgress?.({ phase: 'analyze', processed: Math.min(i + MATCH_BATCH, docs.length), total: docs.length });
  }
  return groups;
}

// Run a per-row async task over `items` with a fixed-size worker pool (the
// sliding-window pattern from downloadCollection.js). Stops on abort.
async function runPool(items, concurrency, signal, task) {
  let next = 0;
  let cancelled = false;
  async function worker() {
    while (true) {
      if (signal?.aborted) { cancelled = true; return; }
      const i = next++;
      if (i >= items.length) return;
      await task(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return cancelled || !!signal?.aborted;
}

export async function executeImport(collection, {
  mode, keys, upsert, docs, plan, batchSize = BATCH_SIZE, concurrency = CONCURRENCY, signal, onProgress,
} = {}) {
  // ---- Insert ----
  if (mode === 'insert') {
    const { kept } = dedupeById(docs);
    const r = await runChunkedInsert(collection, kept, { batchSize, signal, onProgress });
    return { kind: 'insert', applied: 0, inserted: r.inserted, deleted: 0, skipped: 0, failedBatches: r.failedBatches, cancelled: r.cancelled };
  }

  // ---- Replace · key=_id · upsert: legacy overwrite fast path ----
  if (mode === 'replace' && isIdKey(keys) && upsert) {
    const { kept } = dedupeById(docs);
    const r = await runChunkedOverwrite(collection, kept, { batchSize, signal, onProgress });
    return { kind: 'overwrite', applied: 0, inserted: r.inserted, deleted: r.deleted, skipped: 0, failedBatches: r.failedBatches, cancelled: r.cancelled };
  }

  // ---- Update / Replace by key (per-row pool) ----
  const matched = plan?.matched || [];
  const result = { kind: mode, applied: 0, inserted: 0, deleted: 0, skipped: 0, failedBatches: [], cancelled: false };
  let processed = 0;
  const report = () => onProgress?.({ phase: mode, processed, total: matched.length, applied: result.applied });

  const cancelled = await runPool(matched, concurrency, signal, async ({ doc, _id }) => {
    try {
      if (mode === 'update') {
        await api.updateOne(collection, { _id }, { $set: buildUpdateSet(doc, keys) });
      } else {
        await api.replaceOne(collection, { _id }, buildReplacement(doc));
      }
      result.applied++;
    } catch (err) {
      result.failedBatches.push({ startIdx: processed, endIdx: processed, count: 1, message: err?.message || String(err), landedFromChunk: 0 });
    }
    processed++;
    report();
  });
  result.cancelled = cancelled;

  // ---- Upsert tail: insert the non-matching rows ----
  if (upsert && !result.cancelled && plan) {
    const toInsert = [...plan.unmatched, ...plan.missingKey].map(normalizeDocId);
    if (toInsert.length) {
      const r = await runChunkedInsert(collection, toInsert, { batchSize, signal, onProgress: (p) => onProgress?.({ phase: 'insert', ...p }) });
      result.inserted = r.inserted;
      result.failedBatches.push(...r.failedBatches);
      if (r.cancelled) result.cancelled = true;
    }
  } else if (!upsert && plan) {
    result.skipped = plan.unmatched.length + plan.missingKey.length;
  }

  return result;
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-run-import.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/mdh/runImport.js tests/mdh-run-import.test.js
git commit -m "feat(mdh): import executor (probe + mode dispatch + per-row pool)"
```

---

## Task 4: Extract shared import controls into `ImportControls.jsx`

**Files:**
- Create: `src/mdh/components/ImportControls.jsx`
- Modify: `src/mdh/components/CsvImportWizard.jsx` (remove the moved exports; re-import them), `XlsxImportWizard.jsx`, `XmlImportWizard.jsx` (re-point imports)
- Test: existing wizard tests must stay green (no new test file required).

**Interfaces:**
- Produces (moved verbatim from `CsvImportWizard.jsx`): `Segmented({ value, options, onChange, testid, ariaLabel })`, `Toggle({ checked, onChange, title, testid })`, `CsvPreview({ parsed, limit })`, and the internal `PreviewValue`.

- [ ] **Step 1:** Create `src/mdh/components/ImportControls.jsx`. Move the bodies of `Segmented` (CsvImportWizard.jsx:172-188), `Toggle` (191-205), `CsvPreview` (324-366), and `PreviewValue` (368-381) into it **verbatim**, adding at the top:

```jsx
import { h, Fragment } from 'preact';
import { getEjsonType, formatEjsonValue } from '../displayValue.js';
```

Export `Segmented`, `Toggle`, `CsvPreview` (keep `PreviewValue` module-private).

- [ ] **Step 2:** In `CsvImportWizard.jsx` delete those four definitions and the now-unused `getEjsonType/formatEjsonValue` import; add `import { Segmented, Toggle, CsvPreview } from './ImportControls.jsx';`. In `XlsxImportWizard.jsx` change `import { Segmented, Toggle, CsvPreview } from './CsvImportWizard.jsx';` → `from './ImportControls.jsx';`. Same in `XmlImportWizard.jsx` for `{ Toggle }`.

- [ ] **Step 3: Run the affected suites, expect PASS (unchanged behavior)**

Run: `npx vitest run tests/mdh-csv-wizard.test.js tests/mdh-xlsx-wizard.test.js tests/mdh-xml-wizard.test.js`
Expected: PASS — the controls render identically; only their module path changed.

- [ ] **Step 4: Commit**

```bash
git add src/mdh/components/ImportControls.jsx src/mdh/components/CsvImportWizard.jsx src/mdh/components/XlsxImportWizard.jsx src/mdh/components/XmlImportWizard.jsx
git commit -m "refactor(mdh): extract shared import controls into ImportControls.jsx"
```

---

## Task 5: Format registry (`formats/`)

**Files:**
- Create: `src/mdh/formats/json.js`, `src/mdh/formats/jsonl.js`, `src/mdh/formats/csv.jsx`, `src/mdh/formats/xlsx.jsx`, `src/mdh/formats/xml.jsx`, `src/mdh/formats/index.js`
- Test: `tests/mdh-formats.test.js`

**Interfaces:**
- Each format module default-exports an object: `{ id, label, accept, read, defaultOpts, parse(input, opts) -> { docs, columns, warnings, error, ... }, ConfigureControls? }` where `read` is `'text'` or `'arrayBuffer'`. `parse` for `xlsx` is async (returns a Promise); all others are sync. `ConfigureControls` is a Preact component `({ opts, setOpt, parsed }) => VNode` (omitted for json/jsonl).
- `index.js` produces `FORMATS` (object keyed by id) and `getFormat(id)`.

> JSON/JSONL parsing matches `InsertFileWizard.handleFile`: JSON tries `JSON.parse` then wraps a non-array in `[x]`; JSONL uses `parseNdjson`. CSV/XLSX/XML wrap the existing parsers, and their `ConfigureControls` are migrated from the old wizards' Configure stages.

- [ ] **Step 1: Write failing tests** — `tests/mdh-formats.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { FORMATS, getFormat } from '../src/mdh/formats/index.js';

describe('format registry', () => {
  it('exposes the five formats with accept + read type', () => {
    expect(Object.keys(FORMATS).sort()).toEqual(['csv', 'json', 'jsonl', 'xlsx', 'xml']);
    expect(getFormat('csv').read).toBe('arrayBuffer');
    expect(getFormat('xlsx').read).toBe('arrayBuffer');
    expect(getFormat('json').read).toBe('text');
    expect(getFormat('json').accept).toContain('.json');
    expect(getFormat('jsonl').accept).toContain('.jsonl');
  });

  it('json parse wraps a single object into an array', () => {
    expect(getFormat('json').parse('{"a":1}').docs).toEqual([{ a: 1 }]);
    expect(getFormat('json').parse('[{"a":1},{"a":2}]').docs.length).toBe(2);
  });

  it('json parse falls back to NDJSON on whole-file parse failure', () => {
    const r = getFormat('json').parse('{"a":1}\n{"a":2}');
    expect(r.docs).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('jsonl parse rejects a non-jsonl blob with an error', () => {
    expect(getFormat('jsonl').parse('not json\nstill not').error).toBeTruthy();
  });

  it('csv parse yields row objects', () => {
    const r = getFormat('csv').parse(new TextEncoder().encode('a,b\n1,2\n').buffer, getFormat('csv').defaultOpts);
    expect(r.docs).toEqual([{ a: '1', b: '2' }]);
  });

  it('json/jsonl have no ConfigureControls; csv/xlsx/xml do', () => {
    expect(getFormat('json').ConfigureControls).toBeUndefined();
    expect(typeof getFormat('csv').ConfigureControls).toBe('function');
    expect(typeof getFormat('xlsx').ConfigureControls).toBe('function');
    expect(typeof getFormat('xml').ConfigureControls).toBe('function');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-formats.test.js`

- [ ] **Step 3: Implement.**

`src/mdh/formats/json.js`:

```js
import { parseNdjson } from '../ndjson.js';

function parse(text) {
  try {
    let parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return { docs: parsed, columns: [], warnings: [], error: parsed.length ? null : { message: 'File contains no documents' } };
  } catch (jsonErr) {
    const nd = parseNdjson(text);
    if (nd.error) return { docs: [], columns: [], warnings: [], error: { message: `Couldn't parse as JSON or JSON Lines: ${jsonErr.message}` } };
    return { docs: nd.docs, columns: [], warnings: nd.warnings, error: null };
  }
}

export default { id: 'json', label: 'JSON', accept: '.json,application/json', read: 'text', defaultOpts: {}, parse };
```

`src/mdh/formats/jsonl.js`:

```js
import { parseNdjson } from '../ndjson.js';

function parse(text) {
  const nd = parseNdjson(text);
  return { docs: nd.docs, columns: [], warnings: nd.warnings, error: nd.error };
}

export default { id: 'jsonl', label: 'JSONL', accept: '.jsonl,.ndjson,application/x-ndjson', read: 'text', defaultOpts: {}, parse };
```

`src/mdh/formats/csv.jsx` — wrap `parseCsv`; migrate `CsvOptions` (CsvImportWizard.jsx:227-292) into `ConfigureControls`:

```jsx
import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { parseCsv } from '../csv.js';
import { Segmented, Toggle } from '../components/ImportControls.jsx';

const DEFAULT_OPTS = {
  delimiter: ',', quoteChar: '"', escapeChar: '', doubleQuote: true,
  encoding: 'utf-8', hasHeader: true, inferTypes: false, emptyMode: 'empty',
  skipEmptyLines: true, trim: false,
};

function parse(buffer, opts = DEFAULT_OPTS) {
  return parseCsv(buffer, { ...opts, escapeChar: opts.escapeChar || null });
}

// Migrated verbatim from CsvImportWizard.CsvOptions (delimiter / header / infer +
// Advanced: encoding / empty-cell / trim). See CsvImportWizard.jsx:207-292 for the
// DELIM_SEG / ENCODING_SEG / EMPTY_SEG arrays — copy them in unchanged.
function ConfigureControls({ opts, setOpt }) {
  /* ... move CsvOptions body here, swapping its `opts`/`setOpt` props through ... */
}

export default { id: 'csv', label: 'CSV', accept: '.csv,text/csv', read: 'arrayBuffer', defaultOpts: DEFAULT_OPTS, parse, ConfigureControls };
```

`src/mdh/formats/xlsx.jsx` — wrap `parseXlsx` (async); migrate the XlsxStageConfigure toolbar (XlsxImportWizard.jsx:139-160) into `ConfigureControls`:

```jsx
import { h, Fragment } from 'preact';
import { parseXlsx } from '../xlsx.js';
import { Segmented, Toggle } from '../components/ImportControls.jsx';

const DEFAULT_OPTS = { sheet: null, hasHeader: true, emptyMode: 'null', trim: false };

function parse(arrayBuffer, opts = DEFAULT_OPTS) {
  return parseXlsx(arrayBuffer, { sheet: opts.sheet, hasHeader: opts.hasHeader, emptyMode: opts.emptyMode, trim: opts.trim });
}

function ConfigureControls({ opts, setOpt, parsed }) {
  /* ... move the XlsxStageConfigure toolbar (sheet select + header/empty/trim) here ... */
}

export default { id: 'xlsx', label: 'Excel', accept: '.xlsx', read: 'arrayBuffer', defaultOpts: DEFAULT_OPTS, parse, ConfigureControls };
```

`src/mdh/formats/xml.jsx` — wrap `parseXml`; migrate the XmlStageConfigure toolbar (XmlImportWizard.jsx:110-124):

```jsx
import { h, Fragment } from 'preact';
import { parseXml } from '../xml.js';
import { Toggle } from '../components/ImportControls.jsx';

const DEFAULT_OPTS = { recordKey: null, inferTypes: false };

function parse(text, opts = DEFAULT_OPTS) {
  return parseXml(text, { recordKey: opts.recordKey, inferTypes: opts.inferTypes });
}

function ConfigureControls({ opts, setOpt, parsed }) {
  /* ... move the XmlStageConfigure toolbar (record-element select + infer-types) here ... */
}

export default { id: 'xml', label: 'XML', accept: '.xml,text/xml,application/xml', read: 'text', defaultOpts: DEFAULT_OPTS, parse, ConfigureControls };
```

`src/mdh/formats/index.js`:

```js
import json from './json.js';
import jsonl from './jsonl.js';
import csv from './csv.jsx';
import xlsx from './xlsx.jsx';
import xml from './xml.jsx';

export const FORMATS = { json, jsonl, csv, xlsx, xml };
export function getFormat(id) { return FORMATS[id]; }
export const FORMAT_ORDER = ['json', 'csv', 'xlsx', 'xml', 'jsonl'];
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-formats.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/mdh/formats tests/mdh-formats.test.js
git commit -m "feat(mdh): pluggable format registry (json/jsonl/csv/xlsx/xml)"
```

---

## Task 6: `ImportConfirm.jsx` — mode + match-key + live-plan stage

**Files:**
- Create: `src/mdh/components/ImportConfirm.jsx`
- Modify: `src/mdh/components/ImportStages.jsx` (add `ImportProgress`, `ImportSummary`; keep `formatBytes`)
- Test: `tests/mdh-import-confirm.test.js`

**Interfaces:**
- Consumes: `analyzeDocs` from `../importFile.js`; `analyzeFileKeys` from `../importPlan.js`; `formatBytes` from `./ImportStages.jsx`.
- Produces:
  - `ImportConfirm({ fileMeta, docs, columns, mode, setMode, keys, setKeys, upsert, setUpsert, plan, planLoading, indexWarning, onImport, onCancel })`:
    - mode segmented `Insert · Update · Replace`;
    - match-key chip picker (Update/Replace) over `columns` (default `['_id']` when present on all docs);
    - upsert checkbox (Update/Replace);
    - live plan line from `plan.counts` (or in-file analysis for Insert);
    - blockers: non-unique (`plan.blocked` → disable primary, list `ambiguous`/`inFileDupes` counts), missing-key count, soft `indexWarning`;
    - primary button labeled per mode/plan, disabled when nothing to do or blocked.
  - `defaultKeysFor(docs)` → `['_id']` if every doc has `_id`, else `[]`.
- `ImportStages.ImportProgress({ progress })` and `ImportStages.ImportSummary({ result, fileMeta, onClose })` render the phase-aware bar and the multi-mode summary (applied/inserted/replaced/deleted/skipped + failed batches, reusing the current `StageDone` failure list markup).

- [ ] **Step 1: Write failing tests** — `tests/mdh-import-confirm.test.js` (representative cases):

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import ImportConfirm, { defaultKeysFor } from '../src/mdh/components/ImportConfirm.jsx';

function mount(node) { const r = document.createElement('div'); document.body.appendChild(r); render(node, r); return r; }
const base = {
  fileMeta: { name: 'f.json', size: 10 }, docs: [{ _id: '1', a: 1 }], columns: ['_id', 'a'],
  setMode() {}, keys: ['_id'], setKeys() {}, upsert: false, setUpsert() {},
  plan: null, planLoading: false, indexWarning: null, onImport() {}, onCancel() {},
};

describe('defaultKeysFor', () => {
  it('defaults to _id when all docs have it, else empty', () => {
    expect(defaultKeysFor([{ _id: '1' }, { _id: '2' }])).toEqual(['_id']);
    expect(defaultKeysFor([{ _id: '1' }, { a: 1 }])).toEqual([]);
  });
});

describe('ImportConfirm', () => {
  it('Insert mode hides the match-key picker', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
    expect(root.querySelector('[data-testid="match-keys"]')).toBeNull();
  });
  it('Update mode shows the match-key picker and upsert toggle', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'update' }));
    expect(root.querySelector('[data-testid="match-keys"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="upsert-toggle"]')).toBeTruthy();
  });
  it('disables the primary button when the plan is blocked', () => {
    const plan = { blocked: true, ambiguous: [{ keyKey: 'x', count: 3 }], inFileDupes: [], counts: { willApply: 0, willInsert: 0, willSkip: 0, blocked: true } };
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', plan }));
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    expect(root.textContent).toMatch(/unique/i);
  });
  it('shows the live plan sentence for a clean update plan', () => {
    const plan = { blocked: false, ambiguous: [], inFileDupes: [], counts: { willApply: 12, willInsert: 3, willSkip: 0, blocked: false } };
    const root = mount(h(ImportConfirm, { ...base, mode: 'update', upsert: true, plan }));
    expect(root.textContent).toMatch(/12/);
    expect(root.textContent).toMatch(/3/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-confirm.test.js`

- [ ] **Step 3: Implement** `ImportConfirm.jsx` and the `ImportProgress`/`ImportSummary` additions in `ImportStages.jsx`. The plan line:
  - Insert: reuse `analyzeDocs(docs)` for the existing `_id`/dup summary.
  - Update/Replace: `planLoading` → "Analyzing…"; else from `plan.counts`, e.g. `Update {willApply} matched · insert {willInsert} new · skip {willSkip}` (verb = "Update"/"Replace"). Use `{'·'}` for the middot.
  - Match-key picker: checkbox/chip per column in `data-testid="match-keys"`; calling `setKeys` with the new array.
  - Blockers: when `plan.blocked`, show a `.import-conflict-info` with the ambiguous/in-file counts and the literal word "unique"; disable `data-testid="import-go"`.
  - Primary button `data-testid="import-go"`, `btn-danger` for replace/overwrite else `btn-success`/`btn-primary`.

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-import-confirm.test.js tests/mdh-import-stages.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/mdh/components/ImportConfirm.jsx src/mdh/components/ImportStages.jsx tests/mdh-import-confirm.test.js
git commit -m "feat(mdh): mode/match-key/live-plan confirm stage"
```

---

## Task 7: `ImportWizard.jsx` — the unified wizard

**Files:**
- Create: `src/mdh/components/ImportWizard.jsx`
- Test: `tests/mdh-import-wizard.test.js`

**Interfaces:**
- Consumes: `getFormat` from `../formats/index.js`; `FileDropArea`; `ImportConfirm` + `defaultKeysFor`; `ImportProgress`, `ImportSummary` from `./ImportStages.jsx`; `probeCollection`, `executeImport` from `../runImport.js`; `analyzeFileKeys`, `computePlan` from `../importPlan.js`; `selectedCollection` from `../store.js`; `closeModal`; `api.listIndexes`.
- Produces: default export `ImportWizard({ format = 'json', mode: initialMode = 'insert', onSuccess })`. Stage machine: `pick → [configure] → confirm → importing → done`. Recomputes the plan (debounced ~300 ms, abortable) whenever `mode`/`keys`/`upsert` change in `confirm` for update/replace. On import, calls `executeImport`; on `applied/inserted/deleted > 0`, calls `onSuccess`.

- [ ] **Step 1: Write failing tests** — `tests/mdh-import-wizard.test.js` (mock api + store):

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/mdh/api.js');
import * as api from '../src/mdh/api.js';
import { h, render } from 'preact';
import { selectedCollection } from '../src/mdh/store.js';
import ImportWizard from '../src/mdh/components/ImportWizard.jsx';

function mount(node) { const r = document.createElement('div'); document.body.appendChild(r); render(node, r); return r; }
async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const s = Date.now();
  for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() - s > timeout) throw new Error('timeout'); await new Promise((r) => setTimeout(r, interval)); }
}
function file(str, name) { const f = new File([str], name); f.text = async () => str; f.arrayBuffer = async () => new TextEncoder().encode(str).buffer; return f; }
function load(root, f) {
  const input = root.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => { vi.clearAllMocks(); selectedCollection.value = 'vendors'; api.listIndexes.mockResolvedValue({ result: [] }); });

describe('ImportWizard', () => {
  it('JSON insert flow reaches confirm with the insert mode selected', async () => {
    const root = mount(h(ImportWizard, { format: 'json', onSuccess() {} }));
    load(root, file('[{"_id":"1","a":1}]', 'd.json'));
    await waitFor(() => root.querySelector('[data-testid="import-go"]'));
  });

  it('switching to Update runs the probe and shows a plan', async () => {
    api.aggregate.mockResolvedValue({ result: [{ _id: '1', ids: ['x'], count: 1 }] });
    const root = mount(h(ImportWizard, { format: 'json', mode: 'update', onSuccess() {} }));
    load(root, file('[{"_id":"1","a":1}]', 'd.json'));
    await waitFor(() => root.querySelector('[data-testid="match-keys"]'));
    await waitFor(() => api.aggregate.mock.calls.length > 0);
  });

  it('blocks the run when a key matches multiple records', async () => {
    api.aggregate.mockResolvedValue({ result: [{ _id: 'A', ids: ['1', '2'], count: 2 }] });
    const root = mount(h(ImportWizard, { format: 'json', mode: 'update', onSuccess() {} }));
    load(root, file('[{"code":"A","v":1}]', 'd.json'));
    await waitFor(() => { const b = root.querySelector('[data-testid="import-go"]'); return b && b.disabled ? b : null; });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-wizard.test.js`

- [ ] **Step 3: Implement** the stage machine. Key points:
  - PICK: `FileDropArea accept={fmt.accept}`; on file, read via `fmt.read` (`file.text()` or `file.arrayBuffer()`); store the raw input.
  - CONFIGURE: only when `fmt.ConfigureControls` exists; (re)parse on opts change (async for xlsx — use the race-guard pattern from `XlsxImportWizard`); live preview via `CsvPreview`; Next gated on a clean parse.
  - For json/jsonl: parse immediately on pick and jump to CONFIRM.
  - CONFIRM: render `ImportConfirm`. On entering confirm with `mode!=='insert'`, and on every `mode`/`keys`/`upsert` change, debounce-run `recomputePlan`: `analyzeFileKeys` locally + `probeCollection(collection, docs, keys)` then `computePlan`, with an `AbortController` cancelling the prior run; also fire `listIndexes` once to compute `indexWarning` (chosen key not covered by any index). Default keys via `defaultKeysFor`.
  - IMPORTING: `executeImport(collection, { mode, keys, upsert, docs, plan, signal, onProgress })`; render `ImportProgress`.
  - DONE: `ImportSummary`; call `onSuccess` when anything changed.
  - Reuse `useRef(AbortController)` + cleanup-on-unmount from the old wizards.

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-import-wizard.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/mdh/components/ImportWizard.jsx tests/mdh-import-wizard.test.js
git commit -m "feat(mdh): unified ImportWizard (pick/configure/confirm/import/done)"
```

---

## Task 8: Switchover — wire `Import ▾`, retire old wizards

**Files:**
- Modify: `src/mdh/components/DataOperations.jsx`, `src/mdh/components/RecordList.jsx:324-335`, `src/mdh/components/DataPanel.jsx:487-499`
- Delete: `InsertFileWizard.jsx`, `CsvImportWizard.jsx`, `XlsxImportWizard.jsx`, `XmlImportWizard.jsx`
- Tests: retire `tests/mdh-insert-file.test.js`, `mdh-csv-wizard.test.js`, `mdh-xlsx-wizard.test.js`, `mdh-xml-wizard.test.js`; rewrite `mdh-csv-routing.test.js` for the new entry; trim old `StageConfirm` cases from `mdh-import-stages.test.js`.

**Interfaces:**
- `DataOperations.openImport(format, mode, onSuccess, fieldsFn)` → `openModal(title, () => <ImportWizard format={format} mode={mode} onSuccess={onSuccess} />)`. Title from a small map (`Import from JSON` etc.). `openDataOperations('insert', …)` keeps opening the inline `InsertPanel`.

- [ ] **Step 1:** In `DataOperations.jsx`: delete `UpdatePanel`, `ReplacePanel`, `FileInput`, `MatchFields`, `getSelectedMatchFields` and the wizard imports. Add `import ImportWizard from './ImportWizard.jsx';` and the `openImport` helper. Keep `InsertPanel` + its `openDataOperations('insert')` path.

- [ ] **Step 2:** In `RecordList.jsx` `DefaultToolbar`: rename the split button label to `Import`, change its menu to one entry per format calling `onRefresh('import-json'|'import-csv'|'import-xlsx'|'import-xml'|'import-jsonl')`. Keep the main-button action `onRefresh('insert')` (inline insert) OR make the main action `import-json` — pick whichever the existing `SplitButton` API supports cleanly; document the choice in the commit.

- [ ] **Step 3:** In `DataPanel.jsx` `handleRefresh`: replace the `insert-file`/`insert-jsonl-file`/`insert-csv-file`/`insert-xlsx-file`/`insert-xml-file` branches with `import-*` branches calling `openImport('<fmt>', 'insert', invalidateAndRun, currentFields)`; keep `insert` → inline `openDataOperations('insert', …)`.

- [ ] **Step 4:** Delete the four old wizard files and their dedicated tests; rewrite `mdh-csv-routing.test.js` to assert `openImport('csv', …)` mounts `ImportWizard` with `format="csv"`.

- [ ] **Step 5: Build + full suite**

Run: `npm run build && npm test`
Expected: build succeeds; suite green. (Per memory: tests run against `src/`, but the loaded extension runs `dist/` — the build must pass too.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(mdh): unify import behind Import menu; retire per-format wizards"
```

---

## Task 9: Live verification of optional fast paths (gated; scratch collection only)

**Files:** none unless a fast path is adopted (then `runImport.js` + a test).

> **SAFETY:** This task makes WRITE calls to Data Storage. Do it ONLY after the user explicitly confirms, ONLY against a throwaway collection (e.g. `__import_probe__<random>`), and DROP it afterwards. Never touch a real/customer collection; never log customer data.

- [ ] **Step 1:** Ask the user to confirm live verification and to name (or approve) a scratch collection.
- [ ] **Step 2:** Probe **native `options.upsert`**: insert a seed doc; `update_one({code:'X'}, {$set:{v:2}}, {upsert:true})` on a non-existent key; verify a doc was created (`upserted_id` present and findable). Record the result in the spec's §10.
- [ ] **Step 3:** Probe **`$merge`**: attempt `aggregate(scratch, [{$merge:{into: scratch2, on:'code', whenMatched:'merge', whenNotMatched:'insert'}}])`; capture whether it 200s or errors (DocumentDB often lacks it). Record in §10.
- [ ] **Step 4:** Drop the scratch collection(s).
- [ ] **Step 5:** ONLY if a probe proves reliable, open a follow-up change to adopt it as an optimization behind the existing per-row baseline (separate commit, with a test). Otherwise leave the baseline as-is and note "verified unavailable/unreliable" in §10.

---

## Self-Review

**Spec coverage**

- Three modes + upsert toggle → Tasks 6 (UI), 3 (executor). ✓
- All formats, all modes → Task 5 registry + Task 7 wizard (mode is format-agnostic). ✓
- Unify into one wizard; retire 4 wizards → Tasks 5–8. ✓
- `Import ▾` single entry, mode inside → Task 8 (RecordList) + Task 7. ✓
- Configurable match keys, default `_id` → Task 6 (`defaultKeysFor`, picker). ✓
- Mandatory pre-flight probe → Task 3 (`probeCollection`) + Task 7 (recomputePlan). ✓
- Block if non-unique (collection AND in-file) → Task 2 (`computePlan.blocked`) + Task 6 (disable button). ✓
- Update `$set` excludes keys + `_id`; Replace minus `_id`, preserves identity → Task 3 (`buildUpdateSet`/`buildReplacement`, filter by matched `_id`). ✓
- Legacy overwrite fast path (replace · `_id` · upsert) → Task 3. ✓
- Upsert emulated from plan split → Task 3 (upsert tail). ✓
- No `bulk_write` → executor uses chunked + per-row only. ✓
- EJSON `_id` coercion in probe + insert → Task 2 (`coerceKeyValue`) + Task 3 (`normalizeDocId`). ✓
- Index warning → Task 7 (`listIndexes`) surfaced by Task 6. ✓
- Backward-compat (primitives + parser signatures, `runChunkedOverwrite`) → Tasks reuse, don't modify, those. ✓
- Native upsert / `$merge` out of baseline, scratch-only verification → Task 9. ✓
- Live probes never on customer data → Task 9 SAFETY + Global Constraints. ✓

**Placeholder scan:** Tasks 1–3 carry complete code + tests. Tasks 5–8 use bracketed `/* move ... */` markers ONLY for verbatim relocation of existing JSX whose source lines are cited exactly — these are moves, not new logic, so reproducing them in full here adds drift risk, not value. No "TBD"/"handle edge cases"/"add validation" placeholders remain.

**Type consistency:** `keyKeyOf`/`keyValue`/`computePlan`/`buildProbePipeline` names match across Tasks 2, 3, 6, 7. `executeImport` result fields (`kind, applied, inserted, deleted, skipped, failedBatches, cancelled`) are consumed by `ImportSummary` (Task 6) as produced (Task 3). `getFormat`/`FORMATS`/`read`/`ConfigureControls`/`parse` consistent across Tasks 5, 7. `defaultKeysFor` defined in Task 6, used in Task 7. ✓
