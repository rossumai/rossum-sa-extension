# Import Robustness & Match-Key UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the import Update/Replace flow work on real documents (searchable, nested-aware match-key picker), faster on large collections (indexed-prefilter probe), safer (large-import caution), and cleaner (rAF flake guard).

**Architecture:** Extend the pure `importPlan.js` with dotted-path resolution + field discovery + positional group keys; teach `runImport.js`'s `probeCollection` to reconstruct positional composite groups and to prefilter by an indexed key field; add a searchable `MatchKeyPicker` component; wire it + a large-import caution into `ImportConfirm`; guard `RecordList`'s rAF. Downstream stages (`computePlan`, executor, `ImportStages`) are unchanged.

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE, classic JSX pragma `h`), Vitest + jsdom, Rossum Data Storage REST API.

## Global Constraints

- **Build:** esbuild only, classic JSX pragma `h` / `Fragment`. Run `npm run build` after UI changes.
- **Tests:** Vitest, `tests/**/*.test.js`; DOM tests start `// @vitest-environment jsdom`; mock API via `vi.mock('../src/mdh/api.js')`; mount with `h(Component, props)` + Preact `render`; condition-based `waitFor`, never fixed sleeps. One file: `npx vitest run tests/<name>.test.js`; full: `npm test`.
- **JSX unicode:** `\uXXXX` does NOT work in JSX text/attrs — use `{'…'}` / literal char / entity. Fine in JS strings/template literals.
- **Dotted paths:** MongoDB supports dot notation in `$match`/`$in`/field-refs natively. A `$group._id` OBJECT must NOT use dotted keys → composite groups use positional keys `k0,k1,…`.
- **Backward compatibility:** flat keys must behave exactly as today (dotted resolution is a superset). `probeCollection` gains an OPTIONAL `indexedFields` arg (defaulted). `computePlan`, the executor, `defaultKeysFor` (`_id` default), and the parser/stage modules are unchanged. No storage-key changes.
- **No customer data** in tests or logs; no live/customer collection writes.
- **Commits:** the project owner defers commits. Treat every "Commit" step as **"stage + checkpoint for review"** — do NOT run `git commit` unless explicitly asked. Stay on `master`; no branches/worktrees. (These changes layer on prior uncommitted import work in the same tree.)

---

## File Structure

**Modified:**
- `src/mdh/importPlan.js` — add `getPath`, `hasPath`, `collectFieldPaths`; export `coerceKeyValue`; make `keyValue`/`keyKeyOf`/`analyzeFileKeys`/`buildProbePipeline` dotted-aware; composite `buildProbePipeline` uses positional group keys.
- `src/mdh/runImport.js` — `probeCollection` reconstructs positional composite groups and adds an indexed-prefilter path; `buildUpdateSet` unchanged.
- `src/mdh/components/ImportConfirm.jsx` — use `MatchKeyPicker` + `collectFieldPaths`; add the large-import caution.
- `src/mdh/components/ImportWizard.jsx` — pass `indexedFields` into `probeCollection`.
- `src/mdh/components/RecordList.jsx` — guard the `requestAnimationFrame` at ~line 44.
- `src/console/console.css` — picker + caution styles.

**New:**
- `src/mdh/components/MatchKeyPicker.jsx` — searchable chips picker.

**Tests:** extend `tests/mdh-import-plan.test.js`, `tests/mdh-run-import.test.js`, `tests/mdh-import-confirm.test.js`; new `tests/mdh-match-key-picker.test.js`. Untouched: parser tests, `mdh-import-stages`, `mdh-import-wizard` (unless wiring needs it), `mdh-formats`.

---

## Task 1: `importPlan.js` — dotted paths, field discovery, positional groups

**Files:**
- Modify: `src/mdh/importPlan.js`
- Test: `tests/mdh-import-plan.test.js`

**Interfaces (produce):**
- `getPath(doc, 'a.b.c') -> value | undefined` (undefined if any segment missing or traverses a non-object/array).
- `hasPath(doc, 'a.b.c') -> boolean`.
- `collectFieldPaths(docs, { sampleSize=50, maxDepth=5 }) -> string[]` — sorted union of dotted **leaf** paths from a sample; `_id` first if present; arrays & single-`$key` EJSON wrappers are leaves; descends only into plain objects.
- `coerceKeyValue(field, value)` — now **exported** (24-hex→`{$oid}` only when `field === '_id'`).
- `keyValue`/`keyKeyOf`/`analyzeFileKeys` — dotted-aware (use `getPath`/`hasPath`).
- `buildProbePipeline(keys, batch)` — single: `_id:'$path'`; **composite: positional group `_id:{k0:'$path0',…}`**.

- [ ] **Step 1: Write failing tests** — append to `tests/mdh-import-plan.test.js` and update its import line to include the new names:

```js
// update the existing import to add getPath, hasPath, collectFieldPaths, coerceKeyValue:
import {
  keyValue, keyKeyOf, analyzeFileKeys, buildProbePipeline, computePlan, MATCH_BATCH,
  getPath, hasPath, collectFieldPaths, coerceKeyValue,
} from '../src/mdh/importPlan.js';
```

```js
describe('getPath / hasPath', () => {
  it('resolves nested paths and reports presence', () => {
    const doc = { a: { b: { c: 5 } }, x: 1 };
    expect(getPath(doc, 'a.b.c')).toBe(5);
    expect(getPath(doc, 'x')).toBe(1);
    expect(hasPath(doc, 'a.b.c')).toBe(true);
  });
  it('returns undefined/false for missing or non-object segments', () => {
    const doc = { a: { b: 2 }, n: 5 };
    expect(getPath(doc, 'a.b.c')).toBeUndefined();   // b is a number
    expect(getPath(doc, 'a.z')).toBeUndefined();
    expect(hasPath(doc, 'a.z')).toBe(false);
    expect(hasPath(doc, 'n.x')).toBe(false);
    expect(hasPath(null, 'a')).toBe(false);
  });
});

describe('collectFieldPaths', () => {
  it('flattens nested leaf paths, _id first, arrays and EJSON as leaves', () => {
    const docs = [
      { _id: { $oid: 'a'.repeat(24) }, sku: 'A', address: { zip: '1', geo: { lat: 1 } }, tags: [1, 2] },
      { _id: { $oid: 'b'.repeat(24) }, sku: 'B', vendor: { id: 9 } },
    ];
    const paths = collectFieldPaths(docs);
    expect(paths[0]).toBe('_id');                 // _id first
    expect(paths).toContain('sku');
    expect(paths).toContain('address.zip');
    expect(paths).toContain('address.geo.lat');
    expect(paths).toContain('vendor.id');
    expect(paths).toContain('tags');             // array is a leaf
    expect(paths).not.toContain('tags.0');       // no array-index paths
    expect(paths.some((p) => p.startsWith('_id.'))).toBe(false); // EJSON wrapper is a leaf
  });
  it('respects maxDepth', () => {
    const docs = [{ a: { b: { c: { d: 1 } } } }];
    expect(collectFieldPaths(docs, { maxDepth: 2 })).toContain('a.b'); // stops descending at depth 2
  });
});

describe('keyValue with dotted paths', () => {
  it('resolves a nested single key', () => {
    expect(keyValue({ address: { zip: '99' } }, ['address.zip'])).toBe('99');
  });
  it('composite with a nested member; undefined if a path is missing', () => {
    expect(keyValue({ address: { zip: '99' }, sku: 'A' }, ['address.zip', 'sku'])).toEqual({ 'address.zip': '99', sku: 'A' });
    expect(keyValue({ sku: 'A' }, ['address.zip', 'sku'])).toBeUndefined();
  });
});

describe('buildProbePipeline dotted + positional groups', () => {
  it('single nested key uses dotted $in and $group by the dotted ref', () => {
    const stages = buildProbePipeline(['address.zip'], [{ address: { zip: '1' } }, { address: { zip: '2' } }]);
    expect(stages[0]).toEqual({ $match: { 'address.zip': { $in: ['1', '2'] } } });
    expect(stages[1]).toEqual({ $group: { _id: '$address.zip', ids: { $push: '$_id' }, count: { $sum: 1 } } });
  });
  it('composite key uses positional group keys (dot-free _id keys)', () => {
    const stages = buildProbePipeline(['address.zip', 'sku'], [{ address: { zip: '1' }, sku: 'A' }]);
    expect(stages[0]).toEqual({ $match: { $or: [{ $and: [{ 'address.zip': '1' }, { sku: 'A' }] }] } });
    expect(stages[1]).toEqual({ $group: { _id: { k0: '$address.zip', k1: '$sku' }, ids: { $push: '$_id' }, count: { $sum: 1 } } });
  });
});

describe('coerceKeyValue export', () => {
  it('coerces a 24-hex _id and leaves other fields alone', () => {
    const hex = 'a'.repeat(24);
    expect(coerceKeyValue('_id', hex)).toEqual({ $oid: hex });
    expect(coerceKeyValue('sku', hex)).toBe(hex);
  });
});
```

> Also UPDATE the pre-existing composite `buildProbePipeline` test (the one asserting `$group: { _id: { a: '$a', b: '$b' }, … }`) to the new positional shape `$group: { _id: { k0: '$a', k1: '$b' }, … }`. The single-field and `computePlan` tests are unchanged.

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-plan.test.js`

- [ ] **Step 3: Implement** — in `src/mdh/importPlan.js`:

Add near the top (after `hasField`):
```js
// Resolve a dot path (a / a.b.c). Returns undefined if any segment is missing
// or would traverse a non-object / array.
export function getPath(doc, path) {
  let cur = doc;
  for (const seg of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}
export function hasPath(doc, path) {
  let cur = doc;
  for (const seg of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = cur[seg];
  }
  return true;
}

// A single-key object whose one key starts with '$' is an EJSON wrapper
// ({$oid}, {$date}, …) — treat as a leaf, don't descend.
function isEjsonWrapper(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const ks = Object.keys(v);
  return ks.length === 1 && ks[0].startsWith('$');
}

function walkPaths(obj, prefix, depth, maxDepth, out) {
  for (const k of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (depth < maxDepth && v !== null && typeof v === 'object' && !Array.isArray(v) && !isEjsonWrapper(v) && Object.keys(v).length > 0) {
      walkPaths(v, path, depth + 1, maxDepth, out);
    } else {
      out.add(path);
    }
  }
}

// Sorted union of dotted leaf paths across a sample of docs; _id first.
export function collectFieldPaths(docs, { sampleSize = 50, maxDepth = 5 } = {}) {
  const out = new Set();
  const n = Math.min(docs.length, sampleSize);
  for (let i = 0; i < n; i++) {
    const d = docs[i];
    if (d && typeof d === 'object' && !Array.isArray(d)) walkPaths(d, '', 1, maxDepth, out);
  }
  const arr = [...out].sort();
  const idx = arr.indexOf('_id');
  if (idx > 0) { arr.splice(idx, 1); arr.unshift('_id'); }
  return arr;
}
```

Change `coerceKeyValue` from a local `function` to `export function` (same body). Then update the four consumers to use paths:
```js
export function keyValue(doc, keys) {
  if (keys.length === 1) {
    return hasPath(doc, keys[0]) ? getPath(doc, keys[0]) : undefined;
  }
  const out = {};
  for (const k of keys) {
    if (!hasPath(doc, k)) return undefined;
    out[k] = getPath(doc, k);
  }
  return out;
}
```
`keyKeyOf` is unchanged (delegates to `keyValue`). `analyzeFileKeys` is unchanged (delegates to `keyKeyOf`). In `buildProbePipeline`, replace `hasField(d, field)`→`hasPath(d, field)`, `d[field]`→`getPath(d, field)`, `d[kk]`→`getPath(d, kk)`, and build the composite group `_id` positionally:
```js
export function buildProbePipeline(keys, batch) {
  if (keys.length === 1) {
    const field = keys[0];
    const values = [];
    const seen = new Set();
    for (const d of batch) {
      if (!hasPath(d, field)) continue;
      const v = coerceKeyValue(field, getPath(d, field));
      const k = stableKey(v);
      if (seen.has(k)) continue;
      seen.add(k); values.push(v);
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
    or.push({ $and: keys.map((kk) => ({ [kk]: coerceKeyValue(kk, getPath(d, kk)) })) });
  }
  const groupId = {};
  keys.forEach((kk, i) => { groupId['k' + i] = `$${kk}`; });
  return [
    { $match: { $or: or } },
    { $group: { _id: groupId, ids: { $push: '$_id' }, count: { $sum: 1 } } },
  ];
}
```
(`hasField` may become unused — remove it if so, or leave it; ensure no lint error for an unused function by removing it if nothing else uses it.)

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-import-plan.test.js`
- [ ] **Step 5: Commit** (checkpoint) — `git add src/mdh/importPlan.js tests/mdh-import-plan.test.js && git commit -m "feat(mdh): dotted-path match keys, field discovery, positional probe groups"`

---

## Task 2: `runImport.js` — positional reconstruction + indexed-prefilter probe

**Files:**
- Modify: `src/mdh/runImport.js`
- Test: `tests/mdh-run-import.test.js`

**Interfaces:**
- Consumes: `buildProbePipeline`, `MATCH_BATCH`, `keyKeyOf`, `getPath`, `hasPath`, `coerceKeyValue` from `./importPlan.js`; `stableKey` from `./importFile.js`.
- Produces: `probeCollection(collection, docs, keys, { signal, onProgress, indexedFields } = {})` — composite non-prefilter groups reconstructed from positional `_id.k0…kn`; when `keys.length > 1` and a key path is in `indexedFields`, uses an indexed-`$in` prefilter + `$project` + client-side tuple grouping (batched over globally-distinct prefilter values). `buildUpdateSet` is UNCHANGED (a nested key's parent object rides along in `$set`; documented).

- [ ] **Step 1: Write failing tests** — append to `tests/mdh-run-import.test.js` (it already `vi.mock`s api and imports `probeCollection`, `executeImport`, `stableKey`):

```js
import { keyKeyOf } from '../src/mdh/importPlan.js';

describe('probeCollection — composite (positional reconstruction)', () => {
  it('rebuilds tuples from positional group _id and keys them like the file side', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [
      { _id: { k0: 'US', k1: 'NYC' }, ids: ['x'], count: 1 },
      { _id: { k0: 'US', k1: 'LA' }, ids: ['y', 'z'], count: 2 },
    ] });
    const keys = ['country', 'city'];
    const groups = await probeCollection('places', [{ country: 'US', city: 'NYC' }, { country: 'US', city: 'LA' }], keys, {});
    expect(groups.get(keyKeyOf({ country: 'US', city: 'NYC' }, keys))).toEqual({ ids: ['x'], count: 1 });
    expect(groups.get(keyKeyOf({ country: 'US', city: 'LA' }, keys))).toEqual({ ids: ['y', 'z'], count: 2 });
  });
});

describe('probeCollection — indexed prefilter path', () => {
  it('uses a projected $in on an indexed key field and groups tuples client-side', async () => {
    // country is indexed → prefilter on it, project key fields + _id, group client-side.
    api.aggregate.mockResolvedValueOnce({ result: [
      { _id: 'id1', country: 'US', city: 'NYC' },
      { _id: 'id2', country: 'US', city: 'NYC' },   // duplicate tuple → count 2 (ambiguous)
      { _id: 'id3', country: 'US', city: 'LA' },
    ] });
    const keys = ['country', 'city'];
    const groups = await probeCollection('places', [{ country: 'US', city: 'NYC' }, { country: 'US', city: 'LA' }], keys, { indexedFields: new Set(['country']) });
    // aggregate called with a $project pipeline, not a $or
    const stages = api.aggregate.mock.calls[0][1];
    expect(stages[0]).toEqual({ $match: { country: { $in: ['US'] } } });
    expect(stages[1].$project).toBeTruthy();
    expect(groups.get(keyKeyOf({ country: 'US', city: 'NYC' }, keys))).toEqual({ ids: ['id1', 'id2'], count: 2 });
    expect(groups.get(keyKeyOf({ country: 'US', city: 'LA' }, keys))).toEqual({ ids: ['id3'], count: 1 });
  });

  it('falls back to $or when no key field is indexed', async () => {
    api.aggregate.mockResolvedValueOnce({ result: [] });
    await probeCollection('places', [{ country: 'US', city: 'NYC' }], ['country', 'city'], { indexedFields: new Set(['unrelated']) });
    const stages = api.aggregate.mock.calls[0][1];
    expect(stages[0].$match.$or).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-run-import.test.js`

- [ ] **Step 3: Implement** — update imports and `probeCollection` in `src/mdh/runImport.js`:

```js
import { buildProbePipeline, MATCH_BATCH, keyKeyOf, getPath, hasPath, coerceKeyValue } from './importPlan.js';
```
```js
export async function probeCollection(collection, docs, keys, { signal, onProgress, indexedFields } = {}) {
  const groups = new Map();
  const prefilterPath = (keys.length > 1 && indexedFields)
    ? keys.find((k) => indexedFields.has(k))
    : null;

  // ---- indexed-prefilter path (composite key with an indexed field) ----
  if (prefilterPath) {
    const values = [];
    const seen = new Set();
    for (const d of docs) {
      if (!hasPath(d, prefilterPath)) continue;
      const v = coerceKeyValue(prefilterPath, getPath(d, prefilterPath));
      const sk = stableKey(v);
      if (seen.has(sk)) continue;
      seen.add(sk); values.push(v);
    }
    const projection = { _id: 1 };
    for (const kk of keys) projection[kk] = 1;
    for (let i = 0; i < values.length; i += MATCH_BATCH) {
      if (signal?.aborted) break;
      const chunk = values.slice(i, i + MATCH_BATCH);
      const stages = [{ $match: { [prefilterPath]: { $in: chunk } } }, { $project: projection }];
      const res = await api.aggregate(collection, stages, { signal });
      for (const doc of (res.result || [])) {
        const kk = keyKeyOf(doc, keys);
        if (kk === null) continue;
        const g = groups.get(kk) || { ids: [], count: 0 };
        g.ids.push(doc._id); g.count += 1; groups.set(kk, g);
      }
      onProgress?.({ phase: 'analyze', processed: Math.min(i + MATCH_BATCH, values.length), total: values.length });
    }
    return groups;
  }

  // ---- $in (single) / $or (composite) path ----
  for (let i = 0; i < docs.length; i += MATCH_BATCH) {
    if (signal?.aborted) break;
    const batch = docs.slice(i, i + MATCH_BATCH);
    const stages = buildProbePipeline(keys, batch);
    const m = stages[0].$match;
    const empty = (m.$or && m.$or.length === 0) || (keys.length === 1 && (m[keys[0]]?.$in?.length ?? 0) === 0);
    if (!empty) {
      const res = await api.aggregate(collection, stages, { signal });
      for (const row of (res.result || [])) {
        const kk = keys.length === 1
          ? stableKey(row._id)
          : stableKey(compositeTuple(row._id, keys));
        groups.set(kk, { ids: row.ids || [], count: row.count || 0 });
      }
    }
    onProgress?.({ phase: 'analyze', processed: Math.min(i + MATCH_BATCH, docs.length), total: docs.length });
  }
  return groups;
}

// Rebuild the { [keyPath]: value } object from a positional group _id ({k0,k1,…})
// so its stableKey matches keyKeyOf(fileDoc, keys) on the client side.
function compositeTuple(groupId, keys) {
  const obj = {};
  keys.forEach((kk, i) => { obj[kk] = groupId ? groupId['k' + i] : undefined; });
  return obj;
}
```
`buildUpdateSet` and the rest of `runImport.js` are unchanged. (Add a one-line comment on `buildUpdateSet` noting a nested key's parent object rides along in `$set`.)

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-run-import.test.js`
- [ ] **Step 5: Commit** — `git add src/mdh/runImport.js tests/mdh-run-import.test.js && git commit -m "feat(mdh): positional composite probe + indexed-prefilter optimization"`

---

## Task 3: `MatchKeyPicker.jsx` — searchable chips picker

**Files:**
- Create: `src/mdh/components/MatchKeyPicker.jsx`
- Test: `tests/mdh-match-key-picker.test.js`

**Interfaces:**
- Produces: default `MatchKeyPicker({ paths, keys, setKeys })` — renders selected `keys` as removable chips + a filter input over `paths` (excluding selected); adding calls `setKeys([...keys, path])`, removing calls `setKeys(keys.filter(...))`. Root carries `data-testid="match-keys"`; input `data-testid="match-key-input"`; suggestion list `data-testid="match-key-suggest"`.

- [ ] **Step 1: Write failing tests** — `tests/mdh-match-key-picker.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import MatchKeyPicker from '../src/mdh/components/MatchKeyPicker.jsx';

function mount(node) { const r = document.createElement('div'); document.body.appendChild(r); render(node, r); return r; }
const PATHS = ['_id', 'sku', 'address.zip', 'address.country', 'vendor.id'];

describe('MatchKeyPicker', () => {
  it('renders selected keys as chips and does not suggest already-selected paths', () => {
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['_id'], setKeys() {} }));
    expect(root.querySelector('[data-testid="match-keys"]')).toBeTruthy();
    expect(root.textContent).toContain('_id');
    // typing a query that matches _id should not offer it (already selected)
    const input = root.querySelector('[data-testid="match-key-input"]');
    input.value = '_id'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const sugg = root.querySelector('[data-testid="match-key-suggest"]');
    expect(sugg == null || !sugg.textContent.split(/\s+/).includes('_id')).toBe(true);
  });

  it('filters suggestions by query and adds on click', () => {
    const setKeys = vi.fn();
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: [], setKeys }));
    const input = root.querySelector('[data-testid="match-key-input"]');
    input.value = 'address'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const items = [...root.querySelectorAll('.match-key-suggest-item')].map((b) => b.textContent);
    expect(items).toContain('address.zip');
    expect(items).toContain('address.country');
    expect(items).not.toContain('sku');
    root.querySelectorAll('.match-key-suggest-item')[0].click();
    expect(setKeys).toHaveBeenCalledWith(['address.country']); // sorted first among address.*
  });

  it('removes a chip via its ✕ button', () => {
    const setKeys = vi.fn();
    const root = mount(h(MatchKeyPicker, { paths: PATHS, keys: ['_id', 'sku'], setKeys }));
    const removeSku = [...root.querySelectorAll('.match-key-chip')].find((c) => c.textContent.includes('sku')).querySelector('.match-key-chip-x');
    removeSku.click();
    expect(setKeys).toHaveBeenCalledWith(['_id']);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-match-key-picker.test.js`

- [ ] **Step 3: Implement** — `src/mdh/components/MatchKeyPicker.jsx`:

```jsx
import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';

export default function MatchKeyPicker({ paths, keys, setKeys }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const available = paths.filter((p) => !keys.includes(p));
  const suggestions = (q ? available.filter((p) => p.toLowerCase().includes(q)) : available).slice(0, 50);

  function add(p) { if (!keys.includes(p)) setKeys([...keys, p]); setQuery(''); }
  function remove(p) { setKeys(keys.filter((k) => k !== p)); }
  function onKeyDown(e) {
    if (e.key === 'Enter' && suggestions.length > 0) { e.preventDefault(); add(suggestions[0]); }
    else if (e.key === 'Backspace' && query === '' && keys.length > 0) { remove(keys[keys.length - 1]); }
  }

  return (
    <div class="match-key-picker" data-testid="match-keys">
      <div class="match-key-chips">
        {keys.map((k) => (
          <span class="match-key-chip" key={k}>
            {k}
            <button type="button" class="match-key-chip-x" aria-label={`Remove ${k}`} onClick={() => remove(k)}>{'✕'}</button>
          </span>
        ))}
        <input
          class="match-key-input"
          type="text"
          value={query}
          placeholder={keys.length ? 'Add another field…' : 'Type to find a field…'}
          data-testid="match-key-input"
          onInput={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {q && suggestions.length > 0 && (
        <div class="match-key-suggest" data-testid="match-key-suggest">
          {suggestions.map((p) => (
            <button type="button" class="match-key-suggest-item" key={p} onClick={() => add(p)}>{p}</button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-match-key-picker.test.js`
- [ ] **Step 5: Commit** — `git add src/mdh/components/MatchKeyPicker.jsx tests/mdh-match-key-picker.test.js && git commit -m "feat(mdh): searchable match-key picker (chips + filter)"`

---

## Task 4: Wire the picker + guardrail into `ImportConfirm` / `ImportWizard` + CSS

**Files:**
- Modify: `src/mdh/components/ImportConfirm.jsx`, `src/mdh/components/ImportWizard.jsx`, `src/console/console.css`
- Test: `tests/mdh-import-confirm.test.js`

**Interfaces:**
- Consumes: `MatchKeyPicker` (Task 3), `collectFieldPaths` (Task 1); `probeCollection` `indexedFields` arg (Task 2).

- [ ] **Step 1: Write failing tests** — append to `tests/mdh-import-confirm.test.js`:

```js
it('renders the searchable match-key picker in update mode', () => {
  const root = mount(h(ImportConfirm, { ...base, mode: 'update' }));
  expect(root.querySelector('[data-testid="match-key-input"]')).toBeTruthy();
});

it('shows a large-import caution when the plan is big (update)', () => {
  const plan = { blocked: false, ambiguous: [], inFileDupes: [], missingKey: [], counts: { willApply: 24000, willInsert: 0, willSkip: 0, blocked: false } };
  const root = mount(h(ImportConfirm, { ...base, mode: 'update', plan }));
  expect(root.querySelector('[data-testid="import-large-warn"]')).toBeTruthy();
});

it('no large-import caution for a small plan or for insert', () => {
  const small = { blocked: false, ambiguous: [], inFileDupes: [], missingKey: [], counts: { willApply: 3, willInsert: 0, willSkip: 0, blocked: false } };
  const upd = mount(h(ImportConfirm, { ...base, mode: 'update', plan: small }));
  expect(upd.querySelector('[data-testid="import-large-warn"]')).toBeNull();
  const ins = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
  expect(ins.querySelector('[data-testid="import-large-warn"]')).toBeNull();
});
```

> The `base` fixture already exists in this file. Confirm it includes a `docs` array; `collectFieldPaths(base.docs)` drives the picker. The pre-existing "Update mode shows the match-key picker" test (asserting `[data-testid="match-keys"]`) still holds — `MatchKeyPicker`'s root carries that testid.

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-confirm.test.js`

- [ ] **Step 3: Implement.**

In `ImportConfirm.jsx`: add imports and the threshold; compute paths + guardrail; replace the checkbox block; add the caution.

Add these imports (keep the existing `import { analyzeDocs } from '../importFile.js';`, the `Segmented`/`Toggle` and `formatBytes` imports, and the existing `preact`/`preact/hooks` imports — just add `useMemo` to the hooks import):
```jsx
import { useMemo } from 'preact/hooks';           // add useMemo (merge into the existing preact/hooks import)
import { collectFieldPaths } from '../importPlan.js';
import MatchKeyPicker from './MatchKeyPicker.jsx';
```
`collectFieldPaths` lives in `importPlan.js` (NOT `importFile.js`).

Add the constant near the top:
```js
const LARGE_IMPORT_THRESHOLD = 10000;
```
Inside the component, compute:
```js
const fieldPaths = useMemo(() => collectFieldPaths(docs), [docs]);
const perRow = plan ? plan.counts.willApply + plan.counts.willInsert : docs.length;
const largeImport = isMatch && perRow >= LARGE_IMPORT_THRESHOLD;
```
Replace the entire `.match-fields` checkbox block (the `<div class="match-fields" …>…</div>` and its `columns.map(...)`) with:
```jsx
          <MatchKeyPicker paths={fieldPaths} keys={keys} setKeys={setKeys} />
```
(Keep the surrounding "Match existing records by" label, the "Select at least one match field" hint, and the upsert toggle. The `toggleKey` helper and the `columns` prop become unused — remove `toggleKey` and drop `columns` from the destructured props + from the `ImportWizard` call site in the next edit.)

Add the caution in the warnings region (e.g. right before the `<div class="import-summary-callout">`):
```jsx
      {largeImport && (
        <div class="import-warn" data-testid="import-large-warn">
          Large import: ~{perRow.toLocaleString()} per-row writes. {mode === 'replace' ? 'Replace' : 'Update'} runs one write per row {'—'} this may take several minutes.
        </div>
      )}
```

In `ImportWizard.jsx`: pass `indexedFields` into the probe. Change the probe call inside the debounced effect:
```js
const groups = await probeCollection(selectedCollection.value, parsed.docs, keys, { signal: ctrl.signal, indexedFields });
```
And drop the now-unused `columns` prop from the `<ImportConfirm .../>` call (remove the `columns={…}` line).

In `console.css`, add:
```css
.match-key-picker { margin-top: 4px; }
.match-key-chips {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-card);
}
.match-key-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 4px 2px 8px; border-radius: 5px; font-size: 12px;
  background: var(--accent-bg, var(--bg-hover)); color: var(--accent-fg, var(--text-primary));
}
.match-key-chip-x { border: none; background: transparent; cursor: pointer; color: inherit; font-size: 11px; line-height: 1; padding: 0 2px; }
.match-key-input { flex: 1; min-width: 120px; border: none; background: transparent; color: var(--text-primary); font-family: inherit; font-size: 12px; outline: none; padding: 2px; }
.match-key-suggest {
  margin-top: 4px; max-height: 180px; overflow: auto;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-card);
}
.match-key-suggest-item {
  display: block; width: 100%; text-align: left; border: none; background: transparent;
  padding: 6px 10px; font-family: var(--font-mono); font-size: 12px; color: var(--text-primary); cursor: pointer;
}
.match-key-suggest-item:hover { background: var(--bg-hover); }

.import-warn {
  font-size: 12px; line-height: 1.45; padding: 8px 10px; border-radius: var(--radius, 6px);
  background: var(--warning-bg, var(--bg-hover)); color: var(--warning-fg, var(--text-primary));
  border-left: 3px solid var(--warning, var(--accent));
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-import-confirm.test.js tests/mdh-import-wizard.test.js` then `npm run build`
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(mdh): searchable/nested match-key picker + large-import guardrail"`

---

## Task 5: rAF flake guard (`RecordList.jsx`)

**Files:**
- Modify: `src/mdh/components/RecordList.jsx` (around line 44)

- [ ] **Step 1: Read the current effect** — open `src/mdh/components/RecordList.jsx` around line 44; it calls `raf = requestAnimationFrame(() => { … });` inside an effect (with a `cancelAnimationFrame(raf)` cleanup).

- [ ] **Step 2: Guard it** — wrap the scheduling so it only runs when the API exists (mirror `StageLinkOverlay.jsx`):
```js
      if (typeof requestAnimationFrame === 'function') {
        raf = requestAnimationFrame(() => {
          // …existing callback body, unchanged…
        });
      }
```
And make the cleanup tolerant: `if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);` (only if it isn't already guarded).

- [ ] **Step 3: Verify** — `npm test` and confirm the summary no longer prints the `requestAnimationFrame is not defined` unhandled rejection (`mdh-datapanel-disable` and the full suite stay green).
- [ ] **Step 4: Commit** — `git add src/mdh/components/RecordList.jsx && git commit -m "fix(mdh): guard RecordList requestAnimationFrame (jsdom flake)"`

---

## Self-Review

**Spec coverage:** Piece 1 (picker+nesting) → Tasks 1 (paths/discovery/probe) + 3 (component) + 4 (wire). Piece 2 (probe opt) → Task 2. Piece 3 (guardrail) → Task 4. Piece 4 (rAF) → Task 5. ✓

**Placeholder scan:** all steps carry complete code or exact edits; the one prose note (ImportConfirm import correction) explicitly states the exact final import lines. No TBD/"handle edge cases". ✓

**Type consistency:** `getPath`/`hasPath`/`collectFieldPaths`/`coerceKeyValue` names identical across Tasks 1–2; `probeCollection(..., { indexedFields })` matches the Task 4 call; `MatchKeyPicker({ paths, keys, setKeys })` matches its Task 4 usage; composite group shape `{k0,k1}` produced in Task 1 and reconstructed in Task 2 via `compositeTuple`. `data-testid="match-keys"` preserved (checkbox block → MatchKeyPicker root). ✓
