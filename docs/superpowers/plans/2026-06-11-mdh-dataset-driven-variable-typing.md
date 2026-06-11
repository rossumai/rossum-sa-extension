# Dataset-Driven Variable Typing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For a whole-quoted `"{var}"` placeholder in an MDH aggregation, default its JSON type to the *dataset field's* type (detected via `$type`), shown next to the input and overridable — fixing the "type 123, can't match a string field" bug.

**Architecture:** Approach A — keep today's textual substitute-then-`JSON5.parse` path. Add a pure pipeline-analysis pass (`mapPlaceholdersToFields`), a field-type resolver reusing the Stats `$type` machinery (`resolveFieldTypes`), and one new optional `resolvedType` argument threaded into `renderWholeToken`. When no type resolves, every path is byte-identical to today.

**Tech Stack:** Preact + `@preact/signals`, JSON5, esbuild, Vitest (jsdom). No new deps.

**Spec:** `docs/superpowers/specs/2026-06-11-mdh-dataset-driven-variable-typing-design.md`

> **COMMITS — read this.** Per the maintainer's standing preference, this plan contains **no per-task `git commit` steps** and all work stays on `master` uncommitted. Each task instead ends with **"Confirm suite green."** Do **not** create branches or worktrees. Batch-commit only if the maintainer explicitly asks at the end.

> **Test convention** (`tests/mdh-compute-editor-state.test.js`): files are `*.test.js` with a `// @vitest-environment jsdom` header where a hook is rendered; render Preact via `h(Component, null)` (never raw JSX in `.test.js`); use `vi.mock` for module mocks. Hook tests use the `getPipeline()` helper shown in Task 6.

---

## File Structure

**New files**
- `src/mdh/placeholderSyntax.js` — the two placeholder regexes (`VAR_RE`, `VAR_RE_G`), shared by the substituter and the analyzer so they can't drift. (Resolves the `usePipeline ↔ placeholderFields` import cycle.)
- `src/mdh/placeholderFields.js` — `mapPlaceholdersToFields(text)`: pure AST analysis mapping each WHOLE no-modifier placeholder to the field it's compared against.
- `src/mdh/fieldTypes.js` — `foldBsonType`, `transformTypeBuckets`, `deriveResolvedType` (pure) + `resolveFieldTypes` (async, reuses Stats `$type` facet). No import of `usePipeline` (avoids a cycle).

**Modified files**
- `src/mdh/hooks/usePipeline.js` — import the shared regexes; export `isJson5NumberLiteral`; extend `renderWholeToken`/`substitutePlaceholders`/`computeEditorState`; add `placeholderTypes`/`fieldTypes` signals + `setPlaceholderType`, `substituteWithTypes`, `computeEditorStateWithTypes`, `ensureFieldTypes`, `resolvedTypeForName`, `referencedFields`; clear new signals in `reset`.
- `src/mdh/components/PlaceholderInputs.jsx` — `isCompatibleWithType` + `badgeLabel` helpers; per-variable type `<select>` + source badge + warning.
- `src/mdh/components/DataPanel.jsx` — route all `substitutePlaceholders` calls (6 sites) and the editor snapshot through the type-aware variants; field-type detection effect; `await` detection before Run; thread `placeholderTypes` through persistence/restore; pass new props.
- `src/mdh/lastPipeline.js` — persist/restore `placeholderTypes`.
- `src/mdh/components/QueryHistory.jsx` — store/restore `placeholderTypes` in recent/saved entries.
- `src/mdh/components/PipelineEditor.jsx` — pass `placeholderTypes` through the load callback.
- `console.css` — `.placeholder-*` type-control + badge styles.

---

### Task 1: Shared placeholder grammar + enabling exports

**Files:**
- Create: `src/mdh/placeholderSyntax.js`
- Modify: `src/mdh/hooks/usePipeline.js:20-21` (remove local regex consts), `:70` (export), import line near top
- Test: `tests/mdh-placeholder-syntax.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-placeholder-syntax.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { VAR_RE } from '../src/mdh/placeholderSyntax.js';
import { isJson5NumberLiteral } from '../src/mdh/hooks/usePipeline.js';

describe('placeholderSyntax + usePipeline exports', () => {
  it('VAR_RE matches a whole placeholder and captures name/modifier/arg', () => {
    expect(VAR_RE.exec('{code}')[1]).toBe('code');
    const m = VAR_RE.exec('{cats | split(\',\')}');
    expect([m[1], m[2], m[3]]).toEqual(['cats', 'split', "','"]);
    expect(VAR_RE.exec('id-{x}')).toBeNull();
  });
  it('isJson5NumberLiteral is exported and rejects padded/comma forms', () => {
    expect(isJson5NumberLiteral('123')).toBe(true);
    expect(isJson5NumberLiteral('1.5')).toBe(true);
    expect(isJson5NumberLiteral('007')).toBe(false);
    expect(isJson5NumberLiteral('5,000')).toBe(false);
    expect(isJson5NumberLiteral('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-placeholder-syntax.test.js`
Expected: FAIL — `VAR_RE` not exported from `placeholderSyntax.js` (module not found) and/or `isJson5NumberLiteral` not exported.

- [ ] **Step 3: Create the shared module**

`src/mdh/placeholderSyntax.js`:
```js
// Placeholder variable grammar, shared by the substituter (hooks/usePipeline.js)
// and the field-mapping analysis (placeholderFields.js). A variable is a quoted
// "{name}" or "{name | modifier(arg)}". VAR_RE matches a WHOLE string; VAR_RE_G
// finds EMBEDDED occurrences inside a larger string. Kept in one module so the
// two consumers can't drift.
export const VAR_RE = /^\{\s*([a-zA-Z_]\w*)\s*(?:\|\s*([a-zA-Z_]+)(?:\s*\(\s*([^)]*?)\s*\))?\s*)?\}$/;
export const VAR_RE_G = /\{\s*([a-zA-Z_]\w*)\s*(?:\|\s*([a-zA-Z_]+)(?:\s*\(\s*([^)]*?)\s*\))?\s*)?\}/g;
```

- [ ] **Step 4: Refactor `usePipeline.js` to use it + export the number check**

In `src/mdh/hooks/usePipeline.js`, add to the import block near the top:
```js
import { VAR_RE, VAR_RE_G } from '../placeholderSyntax.js';
```
Delete the two local `const VAR_RE = …;` / `const VAR_RE_G = …;` lines (currently `:20-21`).
Change `function isJson5NumberLiteral(val) {` (currently `:70`) to:
```js
export function isJson5NumberLiteral(val) {
```

- [ ] **Step 5: Run tests to verify pass + no regression**

Run: `npx vitest run tests/mdh-placeholder-syntax.test.js tests/mdh-compute-editor-state.test.js`
Expected: PASS (both files green — the regex move and export are behavior-neutral).

- [ ] **Step 6: Confirm suite green** — `npx vitest run` → all green.

---

### Task 2: `mapPlaceholdersToFields` (pipeline → field mapping)

**Files:**
- Create: `src/mdh/placeholderFields.js`
- Test: `tests/mdh-placeholder-fields.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-placeholder-fields.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { mapPlaceholdersToFields as map } from '../src/mdh/placeholderFields.js';

describe('mapPlaceholdersToFields', () => {
  it('direct equality maps to the field', () => {
    expect(map('[{"$match":{"code":"{code}"}}]')).toEqual({ code: { field: 'code', op: '$eq' } });
  });
  it('comparison operators map to the field', () => {
    expect(map('[{"$match":{"qty":{"$gte":"{q}"}}}]')).toEqual({ q: { field: 'qty', op: '$gte' } });
  });
  it('$in array element maps to the field', () => {
    expect(map('[{"$match":{"sku":{"$in":["{a}","x"]}}}]')).toEqual({ a: { field: 'sku', op: '$in' } });
  });
  it('$expr maps the field-path operand', () => {
    expect(map('[{"$match":{"$expr":{"$eq":["$total","{t}"]}}}]')).toEqual({ t: { field: 'total', op: '$eq' } });
  });
  it('dotted key maps to the dotted path; nested object does NOT', () => {
    expect(map('[{"$match":{"address.zip":"{z}"}}]')).toEqual({ z: { field: 'address.zip', op: '$eq' } });
    expect(map('[{"$match":{"address":{"zip":"{z}"}}}]')).toEqual({});
  });
  it('same name on different fields across $or branches is ambiguous', () => {
    expect(map('[{"$match":{"$or":[{"a":{"$eq":"{x}"}},{"b":{"$eq":"{x}"}}]}}]')).toEqual({ x: { ambiguous: true } });
  });
  it('same name on the SAME field across $or branches resolves', () => {
    expect(map('[{"$match":{"$or":[{"a":"{x}"},{"a":{"$eq":"{x}"}}]}}]')).toEqual({ x: { field: 'a', op: '$eq' } });
  });
  it('modifier placeholders are skipped (they force array/string)', () => {
    expect(map('[{"$match":{"tags":"{t | split(\',\')}"}}]')).toEqual({});
  });
  it('non-$match / non-comparison positions are unresolved', () => {
    expect(map('[{"$limit":"{n}"}]')).toEqual({});
    expect(map('[{"$project":{"x":"{p}"}}]')).toEqual({});
  });
  it('unparseable text yields {}', () => {
    expect(map('[{"$match": ]')).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-placeholder-fields.test.js`
Expected: FAIL — module `placeholderFields.js` not found.

- [ ] **Step 3: Implement `placeholderFields.js`**

`src/mdh/placeholderFields.js`:
```js
import JSON5 from 'json5';
import { VAR_RE } from './placeholderSyntax.js';

const CMP_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const ARRAY_OPS = new Set(['$in', '$nin']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

// A string that is a WHOLE placeholder with NO modifier → the variable name,
// else null. Modifier placeholders (split/re) force array/string types, so
// dataset typing never applies and they are skipped here.
function wholeNoModifierName(str) {
  if (typeof str !== 'string') return null;
  const m = VAR_RE.exec(str);
  if (!m || m[2]) return null; // m[2] = modifier present → skip
  return m[1];
}

// Record name→field, marking ambiguous if the name already mapped to a DIFFERENT field.
function record(out, name, field, op) {
  const prev = out[name];
  if (prev === undefined) { out[name] = { field, op }; return; }
  if (prev.ambiguous) return;
  if (prev.field !== field) out[name] = { ambiguous: true };
}

// "$field" → "field"; anything else (incl. placeholders, which never start with $) → null.
function exprFieldPath(v) {
  return (typeof v === 'string' && v.startsWith('$')) ? v.slice(1) : null;
}

function walkExpr(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const el of node) walkExpr(el, out); return; }
  for (const [op, val] of Object.entries(node)) {
    if (CMP_OPS.has(op) && Array.isArray(val) && val.length === 2) {
      const field = exprFieldPath(val[0]) || exprFieldPath(val[1]);
      const name = wholeNoModifierName(val[0]) || wholeNoModifierName(val[1]);
      if (field && name) record(out, name, field, op);
    } else if (op === '$and' || op === '$or' || op === '$not') {
      walkExpr(val, out);
    }
  }
}

// `{ field: <val> }`: <val> may be a WHOLE placeholder, or an operator object
// like { $eq: "{v}" } / { $in: [ "{v}" ] }.
function resolveFieldValue(field, val, out) {
  const direct = wholeNoModifierName(val);
  if (direct) { record(out, direct, field, '$eq'); return; }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    for (const [op, opVal] of Object.entries(val)) {
      if (CMP_OPS.has(op)) {
        const n = wholeNoModifierName(opVal);
        if (n) record(out, n, field, op);
      } else if (ARRAY_OPS.has(op) && Array.isArray(opVal)) {
        for (const el of opVal) {
          const n = wholeNoModifierName(el);
          if (n) record(out, n, field, op);
        }
      }
    }
  }
}

function walkQuery(node, out) {
  if (Array.isArray(node)) { for (const el of node) walkQuery(el, out); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, val] of Object.entries(node)) {
    if (key === '$expr') { walkExpr(val, out); continue; }
    if (LOGICAL_OPS.has(key)) { if (Array.isArray(val)) for (const sub of val) walkQuery(sub, out); continue; }
    if (key === '$not') { walkQuery(val, out); continue; }
    if (key.startsWith('$')) continue; // other operators: ignore
    resolveFieldValue(key, val, out); // key is a field path (incl. dotted)
  }
}

// Map each WHOLE no-modifier placeholder name to the field it is compared
// against, or { ambiguous: true } when one name targets two different fields.
// Names in non-comparison positions are absent. Returns {} on parse failure.
export function mapPlaceholdersToFields(text) {
  let parsed;
  try { parsed = JSON5.parse(text); } catch { return {}; }
  if (!Array.isArray(parsed)) return {};
  const out = {};
  for (const stage of parsed) {
    if (stage && typeof stage === 'object' && stage.$match) walkQuery(stage.$match, out);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-placeholder-fields.test.js`
Expected: PASS (all 11 cases).

- [ ] **Step 5: Confirm suite green** — `npx vitest run` → all green.

---

### Task 3: Field-type fold + transform (pure)

**Files:**
- Create: `src/mdh/fieldTypes.js` (pure helpers only this task)
- Test: `tests/mdh-field-types.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-field-types.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { foldBsonType, transformTypeBuckets } from '../src/mdh/fieldTypes.js';

describe('foldBsonType', () => {
  it('folds numeric subtypes to number, others to category/other', () => {
    expect(['int', 'long', 'double', 'decimal'].map(foldBsonType)).toEqual(['number', 'number', 'number', 'number']);
    expect(foldBsonType('string')).toBe('string');
    expect(foldBsonType('bool')).toBe('boolean');
    expect(foldBsonType('null')).toBe('null');
    expect(['date', 'objectId', 'array', 'object'].map(foldBsonType)).toEqual(['other', 'other', 'other', 'other']);
  });
});

describe('transformTypeBuckets', () => {
  it('single-type field', () => {
    const info = transformTypeBuckets([{ _id: 'string', count: 10 }]);
    expect(info.dominant).toBe('string');
    expect(info.mixed).toBe(false);
    expect(info.share).toBe(1);
  });
  it('mixed field picks the dominant category with a share', () => {
    const info = transformTypeBuckets([{ _id: 'string', count: 8 }, { _id: 'int', count: 2 }]);
    expect(info.dominant).toBe('string');
    expect(info.mixed).toBe(true);
    expect(info.share).toBeCloseTo(0.8);
  });
  it('two numeric subtypes are one category (not mixed)', () => {
    const info = transformTypeBuckets([{ _id: 'int', count: 5 }, { _id: 'long', count: 5 }]);
    expect(info.dominant).toBe('number');
    expect(info.mixed).toBe(false);
  });
  it('count tie prefers string', () => {
    expect(transformTypeBuckets([{ _id: 'int', count: 5 }, { _id: 'string', count: 5 }]).dominant).toBe('string');
  });
  it('excludes the missing bucket', () => {
    const info = transformTypeBuckets([{ _id: 'missing', count: 90 }, { _id: 'string', count: 10 }]);
    expect(info.dominant).toBe('string');
    expect(info.share).toBe(1);
  });
  it('no real data → null', () => {
    expect(transformTypeBuckets([{ _id: 'missing', count: 5 }])).toBeNull();
    expect(transformTypeBuckets([])).toBeNull();
  });
  it('detected non-primitive surfaces via dominantBson', () => {
    const info = transformTypeBuckets([{ _id: 'objectId', count: 7 }]);
    expect(info.dominant).toBe('other');
    expect(info.dominantBson).toBe('objectId');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-field-types.test.js`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Implement the pure helpers**

`src/mdh/fieldTypes.js`:
```js
import * as api from './api.js';
import * as cache from './cache.js';
import { buildTypePipeline, encKey } from './statsPipelines.js';

// MongoDB $type strings → primitive Category. Numeric subtypes fold to 'number';
// everything non-primitive (date/objectId/array/object/…) → 'other'.
const NUMBER_BSON = new Set(['int', 'long', 'double', 'decimal']);
export function foldBsonType(t) {
  if (t === 'string') return 'string';
  if (t === 'bool') return 'boolean';
  if (t === 'null') return 'null';
  if (NUMBER_BSON.has(t)) return 'number';
  return 'other';
}

// Tie-break precedence (most permissive first).
const PRECEDENCE = ['string', 'number', 'boolean', 'null', 'other'];

// $type buckets ([{_id: bsonType, count}], as buildTypePipeline emits) →
// FieldTypeInfo, or null when the field has no non-`missing` data.
export function transformTypeBuckets(buckets) {
  const real = (buckets || []).filter((b) => b && b._id !== 'missing');
  const total = real.reduce((s, b) => s + (b.count || 0), 0);
  if (total === 0) return null;
  const byCat = new Map();
  const bsonByCat = new Map();
  for (const b of real) {
    const cat = foldBsonType(b._id);
    byCat.set(cat, (byCat.get(cat) || 0) + b.count);
    if (!bsonByCat.has(cat)) bsonByCat.set(cat, b._id); // first = highest-count bson for the cat
  }
  let dominant = null;
  let dominantCount = -1;
  for (const cat of PRECEDENCE) {            // precedence order → ties resolve to the earlier cat
    if (!byCat.has(cat)) continue;
    const c = byCat.get(cat);
    if (c > dominantCount) { dominant = cat; dominantCount = c; }
  }
  return {
    dominant,
    dominantBson: bsonByCat.get(dominant),
    share: dominantCount / total,
    distribution: real.map((b) => ({ bsonType: b._id, count: b.count, pct: Math.round((b.count / total) * 100) })),
    mixed: byCat.size > 1,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-field-types.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm suite green** — `npx vitest run` → all green.

---

### Task 4: `deriveResolvedType` (type + source decision)

**Files:**
- Modify: `src/mdh/fieldTypes.js` (append)
- Test: `tests/mdh-field-types.test.js` (append a describe block)

- [ ] **Step 1: Write the failing test** (append to `tests/mdh-field-types.test.js`)

```js
import { deriveResolvedType } from '../src/mdh/fieldTypes.js';

describe('deriveResolvedType', () => {
  const strInfo = { dominant: 'string', dominantBson: 'string', share: 1, distribution: [], mixed: false };
  const base = { override: undefined, fieldMap: { code: { field: 'code', op: '$eq' } }, fieldTypes: { code: strInfo }, parsedOk: true };
  it('uses the dataset field type', () => {
    expect(deriveResolvedType('code', base)).toMatchObject({ type: 'string', source: 'field' });
  });
  it('override beats dataset', () => {
    expect(deriveResolvedType('code', { ...base, override: 'number' })).toMatchObject({ type: 'number', source: 'override' });
  });
  it('mixed field marks source mixed', () => {
    const mixed = { ...strInfo, mixed: true, share: 0.82 };
    expect(deriveResolvedType('code', { ...base, fieldTypes: { code: mixed } })).toMatchObject({ type: 'string', source: 'mixed' });
  });
  it('invalid pipeline → invalid (value-based)', () => {
    expect(deriveResolvedType('code', { ...base, parsedOk: false })).toEqual({ type: undefined, source: 'invalid' });
  });
  it('no field → no-field', () => {
    expect(deriveResolvedType('x', base)).toEqual({ type: undefined, source: 'no-field' });
  });
  it('ambiguous → ambiguous', () => {
    expect(deriveResolvedType('x', { ...base, fieldMap: { x: { ambiguous: true } } })).toEqual({ type: undefined, source: 'ambiguous' });
  });
  it('field type not yet resolved → detecting', () => {
    expect(deriveResolvedType('code', { ...base, fieldTypes: {} })).toMatchObject({ type: undefined, source: 'detecting' });
  });
  it('null field info → no-data (value-based)', () => {
    expect(deriveResolvedType('code', { ...base, fieldTypes: { code: null } })).toMatchObject({ type: undefined, source: 'no-data' });
  });
  it('non-primitive dominant → other (value-based) with detected bson', () => {
    const oid = { dominant: 'other', dominantBson: 'objectId', share: 1, distribution: [], mixed: false };
    expect(deriveResolvedType('code', { ...base, fieldTypes: { code: oid } })).toMatchObject({ type: undefined, source: 'other', detectedBson: 'objectId' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-field-types.test.js`
Expected: FAIL — `deriveResolvedType` not exported.

- [ ] **Step 3: Implement** (append to `src/mdh/fieldTypes.js`)

```js
const PRIMITIVES = new Set(['string', 'number', 'boolean', 'null']);

// Decide a placeholder's resolved type + the SOURCE label for the badge.
// `.type` drives substitution (undefined → value-based, byte-identical to today);
// `.source` drives the badge text.
export function deriveResolvedType(name, { override, fieldMap, fieldTypes, parsedOk }) {
  if (override && override !== 'auto') {
    return PRIMITIVES.has(override) ? { type: override, source: 'override' } : { type: undefined, source: 'no-field' };
  }
  if (!parsedOk) return { type: undefined, source: 'invalid' };
  const m = fieldMap[name];
  if (!m) return { type: undefined, source: 'no-field' };
  if (m.ambiguous) return { type: undefined, source: 'ambiguous' };
  if (!(m.field in fieldTypes)) return { type: undefined, source: 'detecting', field: m.field };
  const info = fieldTypes[m.field];
  if (!info) return { type: undefined, source: 'no-data', field: m.field };
  if (info.dominant === 'other') return { type: undefined, source: 'other', field: m.field, detectedBson: info.dominantBson };
  return { type: info.dominant, source: info.mixed ? 'mixed' : 'field', field: m.field, share: info.share, mixed: info.mixed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-field-types.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm suite green** — `npx vitest run` → all green.

---

### Task 5: `resolveFieldTypes` (async, reuses Stats `$type`)

**Files:**
- Modify: `src/mdh/fieldTypes.js` (append)
- Test: `tests/mdh-resolve-field-types.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-resolve-field-types.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mdh/api.js', () => ({ aggregate: vi.fn() }));
vi.mock('../src/mdh/cache.js', () => ({ get: vi.fn(() => null), set: vi.fn() }));

import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import { resolveFieldTypes } from '../src/mdh/fieldTypes.js';

beforeEach(() => { vi.clearAllMocks(); cache.get.mockReturnValue(null); });

describe('resolveFieldTypes', () => {
  it('probes missing fields and transforms the facet', async () => {
    api.aggregate.mockResolvedValue({ result: [{ code: [{ _id: 'string', count: 8 }, { _id: 'int', count: 2 }] }] });
    const out = await resolveFieldTypes('col', ['code']);
    expect(out.code.dominant).toBe('string');
    expect(out.code.mixed).toBe(true);
    expect(out.code.share).toBeCloseTo(0.8);
    expect(cache.set).toHaveBeenCalledWith('col', 'stats_fieldTypes', expect.any(Object));
  });
  it('encodes dotted field names for the facet key', async () => {
    api.aggregate.mockResolvedValue({ result: [{ a__DOT__b: [{ _id: 'long', count: 5 }] }] });
    const out = await resolveFieldTypes('col', ['a.b']);
    expect(out['a.b'].dominant).toBe('number');
  });
  it('reuses the Stats raw facet (stats_types) without probing', async () => {
    cache.get.mockImplementation((c, f) => (f === 'stats_types' ? { result: [{ vendor: [{ _id: 'string', count: 3 }] }] } : null));
    const out = await resolveFieldTypes('col', ['vendor']);
    expect(api.aggregate).not.toHaveBeenCalled();
    expect(out.vendor.dominant).toBe('string');
  });
  it('probe failure → null (value-based fallback)', async () => {
    api.aggregate.mockRejectedValue(new Error('timeout'));
    const out = await resolveFieldTypes('col', ['x']);
    expect(out.x).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-resolve-field-types.test.js`
Expected: FAIL — `resolveFieldTypes` not exported.

- [ ] **Step 3: Implement** (append to `src/mdh/fieldTypes.js`)

```js
const FIELD_TYPES_KEY = 'stats_fieldTypes'; // 10-min TTL (cache.js: key starts with 'stats')
const RAW_TYPES_KEY = 'stats_types';        // raw $type facet cached by the Stats panel

// Resolve FieldTypeInfo (or null) for each requested field, reusing the Stats
// panel's cached raw $type facet when present, else probing only the missing
// fields with a small buildTypePipeline facet. Always returns an entry for every
// requested field (null = no usable data / probe failed → caller uses value-based).
export async function resolveFieldTypes(collectionName, fields) {
  if (!collectionName || !fields || fields.length === 0) return {};
  const cached = { ...(cache.get(collectionName, FIELD_TYPES_KEY) || {}) };
  let missing = fields.filter((f) => !(f in cached));

  if (missing.length) {
    const facet = cache.get(collectionName, RAW_TYPES_KEY)?.result?.[0];
    if (facet) {
      const still = [];
      for (const f of missing) {
        const buckets = facet[encKey(f)];
        if (buckets) cached[f] = transformTypeBuckets(buckets);
        else still.push(f);
      }
      missing = still;
    }
  }

  if (missing.length) {
    try {
      const facet = (await api.aggregate(collectionName, buildTypePipeline(missing)))?.result?.[0] || {};
      for (const f of missing) cached[f] = transformTypeBuckets(facet[encKey(f)] || []);
    } catch {
      for (const f of missing) cached[f] = null; // don't hammer; value-based fallback
    }
  }

  cache.set(collectionName, FIELD_TYPES_KEY, cached);
  const out = {};
  for (const f of fields) out[f] = f in cached ? cached[f] : null;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-resolve-field-types.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm suite green** — `npx vitest run` → all green.

---

### Task 6: Thread `resolvedType` into substitution

**Files:**
- Modify: `src/mdh/hooks/usePipeline.js:101-105` (`renderWholeToken`), `:193-209` (`substitutePlaceholders`), `:219-228` (`computeEditorState`)
- Test: `tests/mdh-typed-substitution.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-typed-substitution.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { usePipeline } from '../src/mdh/hooks/usePipeline.js';

function getPipeline() {
  let api;
  render(h(() => { api = usePipeline(); return null; }, null), document.createElement('div'));
  return api;
}
const M = '[{"$match":{"code":"{code}"}}]';

describe('computeEditorState with explicit resolvedTypes', () => {
  it('string type forces a numeric-looking value to a string', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '123');
    expect(p.computeEditorState(M, { code: 'string' }).parsed).toEqual([{ $match: { code: '123' } }]);
  });
  it('null vs string "null"', () => {
    const p = getPipeline();
    p.setPlaceholder('code', 'null');
    expect(p.computeEditorState(M, { code: 'string' }).parsed).toEqual([{ $match: { code: 'null' } }]);
    expect(p.computeEditorState(M, { code: 'null' }).parsed).toEqual([{ $match: { code: null } }]);
  });
  it('number type with non-numeric value falls back to a quoted string (parse-safe)', () => {
    const p = getPipeline();
    p.setPlaceholder('code', 'abc');
    expect(p.computeEditorState(M, { code: 'number' }).parsed).toEqual([{ $match: { code: 'abc' } }]);
  });
  it('boolean type with non-bool value falls back to a quoted string', () => {
    const p = getPipeline();
    p.setPlaceholder('code', 'yes');
    expect(p.computeEditorState(M, { code: 'boolean' }).parsed).toEqual([{ $match: { code: 'yes' } }]);
  });
  it('no resolvedTypes → byte-identical value-based (numeric → number)', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '5');
    expect(p.computeEditorState(M).parsed).toEqual([{ $match: { code: 5 } }]);
  });
  it('computeEditorState returns a fieldMap', () => {
    const p = getPipeline();
    expect(p.computeEditorState(M).fieldMap).toEqual({ code: { field: 'code', op: '$eq' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-typed-substitution.test.js`
Expected: FAIL — `computeEditorState` ignores the 2nd arg (string case returns `123` number) and has no `fieldMap`.

- [ ] **Step 3: Extend `renderWholeToken`** — replace the function at `usePipeline.js:101-105` with:

```js
function renderWholeToken(val, modifier, arg, resolvedType) {
  if (!modifier) {
    switch (resolvedType) {
      case 'string':  return JSON.stringify(String(val));
      case 'number':  return isJson5NumberLiteral(val) ? val : JSON.stringify(String(val));
      case 'boolean': return (val === 'true' || val === 'false') ? val : JSON.stringify(String(val));
      case 'null':    return 'null';
      default: // undefined → today's value-based branch order, byte-identical
        if (val === 'true' || val === 'false' || val === 'null') return val;
        if (isJson5NumberLiteral(val)) return val;
        return JSON.stringify(applyModifier(val, modifier, arg));
    }
  }
  return JSON.stringify(applyModifier(val, modifier, arg));
}
```

- [ ] **Step 4: Thread the map through `substitutePlaceholders`** — change its signature/body at `usePipeline.js:193`:

```js
  function substitutePlaceholders(text, resolvedTypes = {}) {
    const matches = scanPlaceholders(text);
    if (matches.length === 0) return text;
    let result = '';
    let last = 0;
    for (const m of matches) {
      result += text.slice(last, m.start);
      const val = m.name in placeholderValues.value ? placeholderValues.value[m.name] : '';
      result += m.whole ? renderWholeToken(val, m.modifier, m.arg, resolvedTypes[m.name])
        : renderEmbeddedFragment(val, m.modifier, m.arg);
      last = m.end;
    }
    result += text.slice(last);
    return result;
  }
```

- [ ] **Step 5: Extend `computeEditorState`** — add the import at the top of `usePipeline.js`:
```js
import { mapPlaceholdersToFields } from '../placeholderFields.js';
```
and replace `computeEditorState` (`:219-228`) with:
```js
  function computeEditorState(text, resolvedTypes = {}) {
    const placeholders = extractPlaceholders(text);
    const substituted = substitutePlaceholders(text, resolvedTypes);
    let parsed = null;
    try {
      const p = JSON5.parse(substituted);
      if (Array.isArray(p)) parsed = p;
    } catch { /* invalid JSON5 — leave parsed null */ }
    const fieldMap = mapPlaceholdersToFields(text);
    return { placeholders, parsed, fieldMap };
  }
```

- [ ] **Step 6: Run tests to verify pass + no regression**

Run: `npx vitest run tests/mdh-typed-substitution.test.js tests/mdh-compute-editor-state.test.js`
Expected: PASS (the existing `computeEditorState` tests still pass — they pass no `resolvedTypes`, so the `default` branch reproduces today's output; `.fieldMap` is additive).

- [ ] **Step 7: Confirm suite green** — `npx vitest run` → all green.

---

### Task 7: usePipeline signals + type-aware bound functions

**Files:**
- Modify: `src/mdh/hooks/usePipeline.js` — import, `stateRef` signals, new functions, `reset`, return object
- Test: `tests/mdh-pipeline-types.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-pipeline-types.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import { usePipeline } from '../src/mdh/hooks/usePipeline.js';

function getPipeline() {
  let api;
  render(h(() => { api = usePipeline(); return null; }, null), document.createElement('div'));
  return api;
}
const M = '[{"$match":{"code":"{code}"}}]';
const strInfo = { dominant: 'string', dominantBson: 'string', share: 1, distribution: [], mixed: false };

describe('usePipeline type-aware functions', () => {
  it('computeEditorStateWithTypes uses the dataset field type as default', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '123');
    p.fieldTypes.value = { code: strInfo };
    expect(p.computeEditorStateWithTypes(M).parsed).toEqual([{ $match: { code: '123' } }]);
  });
  it('explicit override beats the dataset type', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '123');
    p.fieldTypes.value = { code: strInfo };
    p.setPlaceholderType('code', 'number');
    expect(p.computeEditorStateWithTypes(M).parsed).toEqual([{ $match: { code: 123 } }]);
    p.setPlaceholderType('code', 'auto'); // clears
    expect(p.placeholderTypes.value.code).toBeUndefined();
  });
  it('substituteWithTypes produces the typed string', () => {
    const p = getPipeline();
    p.setPlaceholder('code', '123');
    p.fieldTypes.value = { code: strInfo };
    expect(p.substituteWithTypes(M)).toBe('[{"$match":{"code":"123"}}]');
  });
  it('referencedFields lists comparison fields, skipping ambiguous', () => {
    const p = getPipeline();
    expect(p.referencedFields(M)).toEqual(['code']);
    expect(p.referencedFields('[{"$match":{"$or":[{"a":"{x}"},{"b":"{x}"}]}}]')).toEqual([]);
  });
  it('ensureFieldTypes merges resolver output and reports change', async () => {
    const p = getPipeline();
    const fake = async () => ({ code: strInfo });
    expect(await p.ensureFieldTypes('col', ['code'], fake)).toBe(true);
    expect(p.fieldTypes.value.code.dominant).toBe('string');
    expect(await p.ensureFieldTypes('col', ['code'], fake)).toBe(false); // already known
  });
  it('resolvedTypeForName reports the source for the badge', () => {
    const p = getPipeline();
    p.fieldTypes.value = { code: strInfo };
    expect(p.resolvedTypeForName('code', { code: { field: 'code', op: '$eq' } }, true)).toMatchObject({ type: 'string', source: 'field' });
  });
  it('reset clears type state', () => {
    const p = getPipeline();
    p.setPlaceholderType('code', 'number');
    p.fieldTypes.value = { code: strInfo };
    p.reset();
    expect(p.placeholderTypes.value).toEqual({});
    expect(p.fieldTypes.value).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-pipeline-types.test.js`
Expected: FAIL — `fieldTypes`, `setPlaceholderType`, `computeEditorStateWithTypes`, etc. are undefined.

- [ ] **Step 3: Add the resolver import** — at the top of `usePipeline.js`:
```js
import { resolveFieldTypes, deriveResolvedType } from '../fieldTypes.js';
```

- [ ] **Step 4: Add the new signals** — extend the `stateRef.current = { … }` initializer (`usePipeline.js:129-134`) with:
```js
      placeholderTypes: signal({}),
      fieldTypes: signal({}),
```
and add them to the destructure on the next line:
```js
  const { sortState, filterState, placeholderValues, suppressSync, placeholderTypes, fieldTypes } = stateRef.current;
```

- [ ] **Step 5: Add the new functions** — inside `usePipeline`, after `setPlaceholder` (`:213`):
```js
  function setPlaceholderType(name, type) {
    const next = { ...placeholderTypes.value };
    if (!type || type === 'auto') delete next[name];
    else next[name] = type;
    placeholderTypes.value = next;
  }

  // Build { name → primitive type } for the current editor text from the field
  // mapping, resolved field types, and user overrides. Only `.type` is kept
  // (undefined types are omitted → value-based for those names).
  function buildResolvedTypes(text) {
    const fieldMap = mapPlaceholdersToFields(text);
    const ft = fieldTypes.value;
    const pt = placeholderTypes.value;
    const out = {};
    for (const name of extractPlaceholders(text)) {
      const d = deriveResolvedType(name, { override: pt[name], fieldMap, fieldTypes: ft, parsedOk: true });
      if (d.type) out[name] = d.type;
    }
    return out;
  }

  function substituteWithTypes(text) {
    return substitutePlaceholders(text, buildResolvedTypes(text));
  }

  function computeEditorStateWithTypes(text) {
    return computeEditorState(text, buildResolvedTypes(text));
  }

  // Unique comparison fields referenced by the pipeline (skips ambiguous names).
  function referencedFields(text) {
    const fm = mapPlaceholdersToFields(text);
    return [...new Set(Object.values(fm).filter((v) => v && v.field && !v.ambiguous).map((v) => v.field))];
  }

  // Resolve any not-yet-known field types into the fieldTypes signal. Returns
  // true if it fetched something (so the caller can re-snapshot the debug view).
  // `resolver` is injectable for tests; defaults to the live resolveFieldTypes.
  async function ensureFieldTypes(collection, fields, resolver = resolveFieldTypes) {
    if (!collection || !fields || fields.length === 0) return false;
    const missing = fields.filter((f) => !(f in fieldTypes.value));
    if (missing.length === 0) return false;
    const resolved = await resolver(collection, missing);
    fieldTypes.value = { ...fieldTypes.value, ...resolved };
    return true;
  }

  // Badge-facing { type, source } for one variable, given the current fieldMap
  // and whether the pipeline parsed (both come from the editor snapshot).
  function resolvedTypeForName(name, fieldMap, parsedOk) {
    return deriveResolvedType(name, { override: placeholderTypes.value[name], fieldMap, fieldTypes: fieldTypes.value, parsedOk });
  }
```

- [ ] **Step 6: Clear new signals in `reset`** — in `reset()` (`:230-235`) add:
```js
    placeholderTypes.value = {};
    fieldTypes.value = {};
```

- [ ] **Step 7: Export the new API** — add to the returned object (`:237-252`):
```js
    placeholderTypes,
    fieldTypes,
    setPlaceholderType,
    substituteWithTypes,
    computeEditorStateWithTypes,
    referencedFields,
    ensureFieldTypes,
    resolvedTypeForName,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/mdh-pipeline-types.test.js`
Expected: PASS.

- [ ] **Step 9: Confirm suite green** — `npx vitest run` → all green.

---

### Task 8: `isCompatibleWithType` + `badgeLabel` helpers

**Files:**
- Modify: `src/mdh/components/PlaceholderInputs.jsx` (add + export two pure helpers)
- Test: `tests/mdh-placeholder-helpers.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-placeholder-helpers.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { isCompatibleWithType, badgeLabel } from '../src/mdh/components/PlaceholderInputs.jsx';

describe('isCompatibleWithType', () => {
  it('number accepts numeric literals only', () => {
    expect(isCompatibleWithType('123', 'number')).toBe(true);
    expect(isCompatibleWithType('007', 'number')).toBe(false);
    expect(isCompatibleWithType('abc', 'number')).toBe(false);
  });
  it('boolean accepts only true/false', () => {
    expect(isCompatibleWithType('true', 'boolean')).toBe(true);
    expect(isCompatibleWithType('yes', 'boolean')).toBe(false);
  });
  it('string/null/auto always compatible', () => {
    expect(isCompatibleWithType('whatever', 'string')).toBe(true);
    expect(isCompatibleWithType('whatever', 'null')).toBe(true);
    expect(isCompatibleWithType('whatever', undefined)).toBe(true);
  });
});

describe('badgeLabel', () => {
  it('single-type field', () => {
    expect(badgeLabel({ type: 'string', source: 'field', field: 'code' })).toBe('String · from `code`');
  });
  it('mixed field shows share', () => {
    expect(badgeLabel({ type: 'number', source: 'mixed', field: 'qty', share: 0.82 })).toBe('Number · dominant 82%');
  });
  it('override / ambiguous / detecting / other / no-field', () => {
    expect(badgeLabel({ type: 'boolean', source: 'override' })).toBe('Boolean · manual');
    expect(badgeLabel({ type: undefined, source: 'ambiguous' })).toBe('String · ambiguous (multiple fields)');
    expect(badgeLabel({ type: undefined, source: 'detecting' })).toBe('detecting…');
    expect(badgeLabel({ type: undefined, source: 'other', detectedBson: 'objectId' })).toBe('ObjectId · value-based');
    expect(badgeLabel({ type: undefined, source: 'no-field' })).toBe('String · auto (no field)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-placeholder-helpers.test.js`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement** — in `src/mdh/components/PlaceholderInputs.jsx`, add the import and the two exported helpers above the default export:

```js
import { isJson5NumberLiteral } from '../hooks/usePipeline.js';

// Value-based representation a resolved value-based token would take, for the
// "won't match as X" hint. Returns true when the typed token can hold the value.
export function isCompatibleWithType(val, type) {
  if (type === 'number') return isJson5NumberLiteral(val);
  if (type === 'boolean') return val === 'true' || val === 'false';
  return true; // string / null / auto / undefined accept anything
}

const BSON_LABEL = { objectId: 'ObjectId', date: 'Date', timestamp: 'Timestamp', array: 'Array', object: 'Object', binData: 'Binary' };
const CAP = { string: 'String', number: 'Number', boolean: 'Boolean', null: 'Null' };

// Human badge text for a { type, source } from resolvedTypeForName.
export function badgeLabel(rt) {
  switch (rt.source) {
    case 'detecting': return 'detecting…';
    case 'invalid': return 'pending…';
    case 'override': return `${CAP[rt.type]} · manual`;
    case 'field': return `${CAP[rt.type]} · from \`${rt.field}\``;
    case 'mixed': return `${CAP[rt.type]} · dominant ${Math.round((rt.share || 0) * 100)}%`;
    case 'ambiguous': return 'String · ambiguous (multiple fields)';
    case 'other': return `${BSON_LABEL[rt.detectedBson] || rt.detectedBson || 'Other'} · value-based`;
    case 'no-data': return 'String · value-based';
    case 'no-field':
    default: return 'String · auto (no field)';
  }
}
```
(Note: when `type` is undefined the value substitutes value-based; the badge says "String" only as the *displayed* fallback hint, not a forced type.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-placeholder-helpers.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm suite green** — `npx vitest run` → all green.

---

### Task 9: PlaceholderInputs UI — selector + badge + warning

**Files:**
- Modify: `src/mdh/components/PlaceholderInputs.jsx:34-90` (component signature + the per-name row)
- Test: `tests/mdh-placeholder-inputs-render.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-placeholder-inputs-render.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import PlaceholderInputs from '../src/mdh/components/PlaceholderInputs.jsx';

function mount(props) {
  const root = document.createElement('div');
  render(h(PlaceholderInputs, props), root);
  return root;
}

describe('PlaceholderInputs UI', () => {
  const common = {
    names: ['code'], values: { code: '123' }, types: {},
    onSetValue: () => {}, onSetType: () => {}, onRunQuery: () => {},
    resolvedTypeFor: () => ({ type: 'string', source: 'field', field: 'code' }),
  };
  it('renders a type selector and the source badge', () => {
    const root = mount(common);
    expect(root.querySelector('select.placeholder-type-select')).toBeTruthy();
    expect(root.textContent).toContain('String · from `code`');
  });
  it('shows an incompatibility warning when the value cannot match the type', () => {
    const root = mount({ ...common, types: { code: 'number' }, values: { code: 'abc' },
      resolvedTypeFor: () => ({ type: 'number', source: 'override' }) });
    expect(root.querySelector('.placeholder-warn')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-placeholder-inputs-render.test.js`
Expected: FAIL — no `select.placeholder-type-select` / badge text.

- [ ] **Step 3: Implement the UI** — update the component signature (`PlaceholderInputs.jsx:34`) to accept the new props:

```js
export default function PlaceholderInputs({ names, values, types, onSetValue, onSetType, onRunQuery, resolvedTypeFor }) {
```
and replace the per-name row (`:75-87`) with:
```js
      {names.map((name) => {
        const rt = resolvedTypeFor ? resolvedTypeFor(name) : { type: undefined, source: 'no-field' };
        const effective = (types && types[name]) || rt.type; // for the compat check
        const incompatible = (values[name] || '') !== '' && !isCompatibleWithType(values[name] || '', effective);
        return (
          <div class="placeholder-row" key={name}>
            <span class="placeholder-name">{`{${name}}`}</span>
            <input
              class="input placeholder-input"
              value={values[name] || ''}
              onInput={(e) => { onSetValue(name, e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') onRunQuery(); }}
            />
            <select
              class="placeholder-type-select"
              value={(types && types[name]) || 'auto'}
              title={badgeLabel(rt)}
              onChange={(e) => onSetType(name, e.target.value)}
            >
              <option value="auto">Auto</option>
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
            </select>
            <span class="placeholder-badge">{badgeLabel(rt)}</span>
            {incompatible && (
              <span class="placeholder-warn" title="The value can't be matched as this type">
                {`won't match as ${effective === 'number' ? 'Number' : 'Boolean'}`}
              </span>
            )}
          </div>
        );
      })}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mdh-placeholder-inputs-render.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm suite green** — `npx vitest run` → all green.

---

### Task 10: DataPanel wiring

**Files:**
- Modify: `src/mdh/components/DataPanel.jsx` — `:51`, `:95-102`, `:200`, `:458`, `:536`, `:617`, `:709`, `:420-428` (+ new `handleSetPlaceholderType`), new effect, `:847-852`

> No new unit test (this is integration glue verified by the existing suite staying green + manual verification in Task 13). Each edit is mechanical and small.

- [ ] **Step 1: Route the editor snapshot through types** — change `:51`:
```js
  const [editorState, recomputeEditorState] = useEditorSnapshot(editorRef, pipeline.computeEditorStateWithTypes);
```

- [ ] **Step 2: Replace all 6 `substitutePlaceholders` calls with `substituteWithTypes`** — at `:200`, `:458`, `:536`, `:617`, `:709` change `pipeline.substitutePlaceholders(` → `pipeline.substituteWithTypes(`. (These are the `currentPipelineFilter` and the download/bulk paths.)

- [ ] **Step 3: Await detection + type-aware run** — replace `runQuery` (`:95-102`):
```js
  async function runQuery() {
    if (!collection || !editorRef.current) return;
    const rawText = editorRef.current.getValue();
    await pipeline.ensureFieldTypes(collection, pipeline.referencedFields(rawText));
    const result = await query.runQuery(collection, rawText, pipeline.substituteWithTypes);
    if (result) {
      addToHistory(collection, rawText, { ...pipeline.placeholderValues.value }, { ...pipeline.placeholderTypes.value });
    }
  }
```

- [ ] **Step 4: Detect field types as the pipeline changes** — add this effect right after the `[collection]` effect (after `:173`):
```js
  useEffect(() => {
    if (!collection || !editorRef.current) return;
    pipeline.ensureFieldTypes(collection, pipeline.referencedFields(editorState.text))
      .then((changed) => { if (changed) recomputeEditorState(); });
  }, [editorState.text, collection]);
```
(Depends on `editorState.text`, which only changes on a real edit — so the post-fetch `recomputeEditorState()` refreshes the Pipeline Debug without re-triggering the effect.)

- [ ] **Step 5: Add the type-change handler** — after `handleSetPlaceholder` (`:428`):
```js
  function handleSetPlaceholderType(name, type) {
    pipeline.setPlaceholderType(name, type);
    persistLastPipeline();
    recomputeEditorState();
    clearTimeout(handleSetPlaceholder._timer);
    handleSetPlaceholder._timer = setTimeout(runQuery, 400);
  }
```

- [ ] **Step 6: Pass the new props** — replace the `<PlaceholderInputs … />` block (`:847-852`):
```jsx
        <PlaceholderInputs
          names={placeholderNames}
          values={pipeline.placeholderValues.value}
          types={pipeline.placeholderTypes.value}
          onSetValue={handleSetPlaceholder}
          onSetType={handleSetPlaceholderType}
          onRunQuery={runQuery}
          resolvedTypeFor={(name) => pipeline.resolvedTypeForName(name, editorState.fieldMap || {}, editorState.parsed != null)}
        />
```

- [ ] **Step 7: Confirm suite green + build**

Run: `npx vitest run && npm run build`
Expected: tests green; build succeeds (no import cycles, JSX compiles).

---

### Task 11: Persistence — thread `placeholderTypes`

**Files:**
- Modify: `src/mdh/lastPipeline.js:12-18` (`saveLastPipeline`), `:24-33` (`bootPrefillFor`)
- Modify: `src/mdh/components/QueryHistory.jsx:29-45` (`addToHistory`/`saveQuery`), `:70` (`QueryRow` onLoad)
- Modify: `src/mdh/components/PipelineEditor.jsx:84-86` (`loadFromPanel`)
- Modify: `src/mdh/components/DataPanel.jsx` — `:121/:135/:150` (restore), `:177-181` (cleanup), `:321` (persist), `:341-356` (`handleLoadPipeline`)
- Test: `tests/mdh-persistence-types.test.js`

- [ ] **Step 1: Write the failing test**

`tests/mdh-persistence-types.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { bootPrefillFor } from '../src/mdh/lastPipeline.js';

describe('bootPrefillFor carries placeholderTypes', () => {
  it('passes through stored placeholderTypes (absent → {})', () => {
    const withTypes = bootPrefillFor({ pipelineText: '[]', variables: { a: '1' }, placeholderTypes: { a: 'string' } }, 'col', false);
    expect(withTypes.placeholderTypes).toEqual({ a: 'string' });
    const legacy = bootPrefillFor({ pipelineText: '[]', variables: {} }, 'col', false);
    expect(legacy.placeholderTypes).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-persistence-types.test.js`
Expected: FAIL — `placeholderTypes` is `undefined` on the returned object.

- [ ] **Step 3: Update `lastPipeline.js`** — replace `saveLastPipeline` (`:12-18`) and `bootPrefillFor` return (`:28-32`):
```js
export function saveLastPipeline(pipelineText, variables, placeholderTypes) {
  try {
    chrome.storage.local.set({
      [lastPipelineKey()]: {
        pipelineText,
        variables: { ...(variables || {}) },
        placeholderTypes: { ...(placeholderTypes || {}) },
      },
    });
  } catch { /* storage unavailable — non-fatal */ }
}
```
and in `bootPrefillFor`'s returned object add the field:
```js
  return {
    collection: selectedCollection,
    pipelineText: stored.pipelineText,
    variables: { ...(stored.variables || {}) },
    placeholderTypes: { ...(stored.placeholderTypes || {}) },
  };
```

- [ ] **Step 4: Update `QueryHistory.jsx`** — in `addToHistory` (`:29`) and `saveQuery` (`:39`) accept and store the map; in `QueryRow` (`:70`) pass it to `onLoad`:
```js
export async function addToHistory(collection, pipeline, variables, placeholderTypes) {
  const queryHistory = await readList('queryHistory');
  const key = dedupKey(collection, pipeline);
  const filtered = queryHistory.filter((e) => dedupKey(e.collection, e.pipeline) !== key);
  const entry = { collection, pipeline, ts: Date.now() };
  if (variables && Object.keys(variables).length > 0) entry.variables = variables;
  if (placeholderTypes && Object.keys(placeholderTypes).length > 0) entry.placeholderTypes = placeholderTypes;
  filtered.unshift(entry);
  await writeList('queryHistory', filtered.slice(0, MAX_HISTORY));
}

export async function saveQuery(collection, pipeline, name, variables, placeholderTypes) {
  const savedQueries = await readList('savedQueries');
  const entry = { collection, pipeline, name, ts: Date.now() };
  if (variables && Object.keys(variables).length > 0) entry.variables = variables;
  if (placeholderTypes && Object.keys(placeholderTypes).length > 0) entry.placeholderTypes = placeholderTypes;
  savedQueries.push(entry);
  await writeList('savedQueries', savedQueries);
}
```
In `QueryRow` change the onClick load call (`:70`):
```js
      <div class="query-history-item-info" onClick={() => { onLoad(item.pipeline, item.collection, item.variables, item.placeholderTypes); onDismiss(); }}>
```

- [ ] **Step 5: Update `PipelineEditor.jsx`** — `loadFromPanel` (`:84-86`):
```js
  function loadFromPanel(pipeline, collection, variables, placeholderTypes) {
    setLibraryOpen(false);
    onLoadPipeline(pipeline, collection, variables, placeholderTypes);
  }
```
(Keep `:79` `saveQuery(collection, editorRef.current.getValue(), name || null, {})` as-is — the save button stores a template with no filled variables or types. The `setLibraryOpen(false)` line is the existing library-close call — preserve it; only the 4th arg is added.)

- [ ] **Step 6: Update `DataPanel.jsx` restore/persist points**
  - Cleanup `saveStateForCleanup` (`:177-181`) — add to the saved object:
```js
      placeholderTypes: { ...pipeline.placeholderTypes.value },
```
  - `persistLastPipeline` (`:321`):
```js
      saveLastPipeline(editorRef.current.getValue(), pipeline.placeholderValues.value, pipeline.placeholderTypes.value);
```
  - The three restore branches — add a line beside each existing `…placeholderValues.value = { ...X.variables }`:
    - external (`:121`): `if (external.placeholderTypes) pipeline.placeholderTypes.value = { ...external.placeholderTypes };`
    - pending (`:135`): `if (pending.placeholderTypes) pipeline.placeholderTypes.value = { ...pending.placeholderTypes };`
    - saved (`:150`): `if (saved.placeholderTypes) pipeline.placeholderTypes.value = { ...saved.placeholderTypes };`
  - `handleLoadPipeline` (`:341-356`) — add the param and thread it:
```js
  function handleLoadPipeline(pipelineText, col, variables, placeholderTypes) {
    if (col && col !== collection) {
      pendingLoadRef.current = { pipelineText, variables, placeholderTypes };
      selectedCollection.value = col;
      return;
    }
    if (selectionMode.value) selectionPipelineDirty.value = true;
    if (variables) pipeline.placeholderValues.value = { ...variables };
    if (placeholderTypes) pipeline.placeholderTypes.value = { ...placeholderTypes };
    if (editorRef.current) {
      pipeline.suppressSync.value = true;
      editorRef.current.setValue(pipelineText);
      setTimeout(() => { pipeline.suppressSync.value = false; runQuery(); }, 100);
    }
  }
```

- [ ] **Step 7: Run test + suite**

Run: `npx vitest run tests/mdh-persistence-types.test.js && npx vitest run`
Expected: PASS; full suite green.

- [ ] **Step 8: Confirm suite green** — `npx vitest run` → all green.

---

### Task 12: Styles

**Files:**
- Modify: `console.css` (append `.placeholder-*` rules)

- [ ] **Step 1: Add styles** — append to `console.css`:
```css
.placeholder-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.placeholder-type-select {
  font-size: 11px; padding: 1px 4px; border: 1px solid var(--border);
  border-radius: 4px; background: var(--surface); color: var(--fg);
}
.placeholder-badge { font-size: 11px; color: var(--fg-muted, #888); white-space: nowrap; }
.placeholder-warn { font-size: 11px; color: var(--warning-fg, #9a6700); white-space: nowrap; }
```
(Match the surrounding variable names actually used in `console.css` — adjust `--fg-muted`/`--warning-fg` to the file's existing tokens if these aren't defined.)

- [ ] **Step 2: Build + eyeball**

Run: `npm run build`
Expected: succeeds. Load `dist/` as an unpacked extension, open Dataset Management, add a `{var}` pipeline, and confirm the selector + badge render and wrap cleanly in light and dark mode.

- [ ] **Step 3: Confirm suite green** — `npx vitest run` → all green.

---

### Task 13: Full verification + live coercion check

**Files:** none (verification only)

- [ ] **Step 1: Full suite + build**

Run: `npm test && npm run build`
Expected: all tests green; clean build.

- [ ] **Step 2: CSP / bundle sanity** — confirm no new `new Function`/`eval` crept in:

Run: `grep -c "new Function" dist/console/console.js`
Expected: `0` (or unchanged from before).

- [ ] **Step 3: Live behavior — the original bug** (manual, against a real Data Storage collection)
  - A collection with a string field `code` storing `"123"`. Pipeline `[{"$match":{"code":"{code}"}}]`, type `123`. Badge shows `String · from \`code\``; query returns the row. (Before this change it returned 0.)
  - Override the selector to `Number`; badge shows `Number · manual`; query returns 0 (expected — confirms override works).

- [ ] **Step 4: Live behavior — BSON numeric coercion** (the spec's must-verify)
  - On a field stored as `{$numberLong:"123"}` (and one as `{$numberDecimal:"123"}`), confirm a `Number`-resolved `{var}=123` matches in BOTH a direct `$eq` and an `$in` position.
  - If any subtype does **not** match: in `fieldTypes.js`, fold that subtype to `'other'` (so it stays value-based) and record it in the spec's §11. Re-run the suite.

- [ ] **Step 5: Live behavior — null + mixed + ambiguous**
  - `null` against a string field stays the string `"null"` (Auto); switching to `Null` matches JSON `null`.
  - A known mixed field shows `… · dominant N%` and matches the dominant-typed value.
  - `[{"$match":{"$or":[{"a":"{x}"},{"b":"{x}"}]}}]` shows `String · ambiguous (multiple fields)` and runs value-based.

- [ ] **Step 6: Regression — bulk/download path** — with a typed `{var}` pipeline, run **Download filtered** and a **bulk update/delete preview**; confirm the count matches what the main grid shows (i.e. they used the same typed substitution, not value-based).

---

## Self-review notes (author)

- Every spec section maps to a task: §5.1→T2, §5.2→T3/T5, §5.5 `deriveResolvedType`→T4, §5.3/§5.4→T6, signals/bound fns→T7, §5.6 UI→T8/T9, §5.7 run timing→T10, §7 persistence→T11, §8 cost (cache key/TTL)→T5, §9 tests→T2–T9+T13, §10 files→all, §11 live coercion→T13.
- Type/name consistency: `FieldTypeInfo` fields (`dominant`, `dominantBson`, `share`, `distribution`, `mixed`) are produced in T3 and consumed unchanged in T4/T8; `{ type, source, field, share, mixed, detectedBson }` from `deriveResolvedType` (T4) is consumed by `badgeLabel` (T8) and `resolvedTypeForName` (T7) with matching keys; `substituteWithTypes`/`computeEditorStateWithTypes`/`referencedFields`/`ensureFieldTypes`/`resolvedTypeForName`/`setPlaceholderType` are defined in T7 and consumed in T10 with identical names.
- No-cycle check: `placeholderSyntax` (leaf) ← `placeholderFields`, `usePipeline`; `fieldTypes` ← `usePipeline`, `DataPanel` (and imports only `api`/`cache`/`statsPipelines`, never `usePipeline`); `PlaceholderInputs` imports `isJson5NumberLiteral` from `usePipeline` (one-way). No cycles.
