# MDH Placeholder Type Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension's placeholder *type* inference faithful to real MDH so a numeric-looking ID typed as `enum_value_type: "string"` is injected as a string (not a number), across the Provenance panel, the "open in new tab" bridge, and the standalone pipeline editor.

**Architecture:** Three components. (1) Provenance reads the queue schema for authoritative types. (2) Provenance's "Open in Dataset Management" propagates those types into the editor's existing `placeholderTypes` override channel. (3) The editor's field-type sampling becomes collection-aware, descending into `$unionWith`/`$lookup` targets. Editor precedence: override/propagated > field-sample > value-based (number, badged).

**Tech Stack:** Preact + `@preact/signals`, JSON5, Chrome MV3 (`chrome.storage.session`/`local`), Vitest (`tests/*.test.js`, classic JSX pragma `h`).

Design spec: `docs/superpowers/specs/2026-07-07-mdh-placeholder-type-inference-design.md`.

## Global Constraints

- **No git commits during execution.** Per the user's standing preference, stay on `master`, create no branches/worktrees, and do not commit. Each task ends with a green-test checkpoint instead of a commit.
- **Tests:** `.test.js` under `tests/`, run via `npm test` (`vitest run`). Components rendered with `h(Component, null)` + `vi.mock`; never raw JSX in `.test.js`. Baseline is **1785 tests green** — keep them green after every task.
- **Build check for UI changes:** `npm run build` must succeed; the loaded extension runs `dist/`, so after UI-affecting tasks tell the user to reload the extension (tests alone don't prove the built extension).
- **No behavior change to real MDH, the hook, or stored data** — client-side inference only.
- **Value-based fallback default stays `number`** for numeric-looking values (backward compatibility); it is only made visible, never changed.
- **MDH type distinction is number-vs-string only** (`mdh-provenance.js:213`) — no boolean/null in schema/propagation maps.
- **JSX unicode:** never put `\uXXXX` in JSX text/attributes; use `{'…'}` or the literal glyph (see CLAUDE.md).

---

### Task 1: Collection-aware `mapPlaceholdersToFields`

Descend into `$unionWith`/`$lookup`/`$facet` sub-pipelines, tracking which collection each comparison runs against. Pure/text-only: `collection` is `null` for top-level (the active collection) or the raw `$unionWith.coll` / `$lookup.from` string (which may contain `{vars}`). Return shape gains `collection`.

**Files:**
- Modify: `src/mdh/placeholderFields.js`
- Test: `tests/mdh-placeholder-fields.test.js`

**Interfaces:**
- Produces: `mapPlaceholdersToFields(text) → { [name]: { field, collection, op } | { ambiguous: true } }`, where `collection` is `null` (active collection) or a non-empty string (possibly containing `{var}` placeholders). A name is `{ambiguous:true}` if it maps to two different `(field, collection)` pairs.
- Consumed by: Task 2 (`usePipeline` resolves `collection`), and existing `referencedFields`/`resolvedTypeForName`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/mdh-placeholder-fields.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { mapPlaceholdersToFields } from '../src/mdh/placeholderFields.js';

describe('mapPlaceholdersToFields — collection-aware', () => {
  it('top-level $match maps to the active collection (null)', () => {
    const text = JSON.stringify([{ $match: { vat: '{sender_vat}' } }]);
    expect(mapPlaceholdersToFields(text)).toEqual({
      sender_vat: { field: 'vat', collection: null, op: '$eq' },
    });
  });

  it('descends into $unionWith.coll (raw coll string, may contain vars)', () => {
    const text = JSON.stringify([
      { $match: { _id: '#' } },
      { $unionWith: { coll: '_{prefix}_material_match', pipeline: [
        { $match: { customer_match: '{customer_match}' } },
      ] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({
      customer_match: { field: 'customer_match', collection: '_{prefix}_material_match', op: '$eq' },
    });
  });

  it('descends into $lookup.pipeline against the from collection', () => {
    const text = JSON.stringify([
      { $lookup: { from: 'PROD_Materials', as: 'm', pipeline: [
        { $match: { code: '{item_code}' } },
      ] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({
      item_code: { field: 'code', collection: 'PROD_Materials', op: '$eq' },
    });
  });

  it('same name against two different collections → ambiguous', () => {
    const text = JSON.stringify([
      { $match: { id: '{x}' } },
      { $unionWith: { coll: 'other', pipeline: [{ $match: { id: '{x}' } }] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({ x: { ambiguous: true } });
  });

  it('skips a $unionWith with no coll (e.g. $documents) — no false active-collection mapping', () => {
    const text = JSON.stringify([
      { $unionWith: { pipeline: [{ $match: { k: '{v}' } }] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({});
  });

  it('$facet sub-pipelines resolve against the same (active) collection', () => {
    const text = JSON.stringify([
      { $facet: { a: [{ $match: { f: '{v}' } }] } },
    ]);
    expect(mapPlaceholdersToFields(text)).toEqual({
      v: { field: 'f', collection: null, op: '$eq' },
    });
  });

  it('returns {} on parse failure', () => {
    expect(mapPlaceholdersToFields('not json')).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mdh-placeholder-fields.test.js`
Expected: FAIL — entries lack `collection`; `$unionWith`/`$lookup`/`$facet` descent missing.

- [ ] **Step 3: Rewrite `placeholderFields.js` with collection tracking**

Replace the bottom of `src/mdh/placeholderFields.js` (from `record` through `mapPlaceholdersToFields`) with:

```js
// Record name→{field, collection}, marking ambiguous if the name already mapped
// to a DIFFERENT (field, collection) pair. `collection` is null (active) or a
// non-empty raw string (possibly containing {var} placeholders).
function record(out, name, field, collection, op) {
  const prev = out[name];
  if (prev === undefined) { out[name] = { field, collection, op }; return; }
  if (prev.ambiguous) return;
  if (prev.field !== field || (prev.collection || null) !== (collection || null)) {
    out[name] = { ambiguous: true };
  }
}

// "$field" → "field"; anything else (incl. placeholders, which never start with $) → null.
function exprFieldPath(v) {
  return (typeof v === 'string' && v.startsWith('$')) ? v.slice(1) : null;
}

function walkExpr(node, out, collection) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const el of node) walkExpr(el, out, collection); return; }
  for (const [op, val] of Object.entries(node)) {
    if (CMP_OPS.has(op) && Array.isArray(val) && val.length === 2) {
      const field = exprFieldPath(val[0]) || exprFieldPath(val[1]);
      const name = wholeNoModifierName(val[0]) || wholeNoModifierName(val[1]);
      if (field && name) record(out, name, field, collection, op);
    } else if (op === '$and' || op === '$or' || op === '$not') {
      walkExpr(val, out, collection);
    }
  }
}

function resolveFieldValue(field, val, out, collection) {
  const direct = wholeNoModifierName(val);
  if (direct) { record(out, direct, field, collection, '$eq'); return; }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    for (const [op, opVal] of Object.entries(val)) {
      if (CMP_OPS.has(op)) {
        const n = wholeNoModifierName(opVal);
        if (n) record(out, n, field, collection, op);
      } else if (ARRAY_OPS.has(op) && Array.isArray(opVal)) {
        for (const el of opVal) {
          const n = wholeNoModifierName(el);
          if (n) record(out, n, field, collection, op);
        }
      }
    }
  }
}

function walkQuery(node, out, collection) {
  if (Array.isArray(node)) { for (const el of node) walkQuery(el, out, collection); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, val] of Object.entries(node)) {
    if (key === '$expr') { walkExpr(val, out, collection); continue; }
    if (LOGICAL_OPS.has(key)) { if (Array.isArray(val)) for (const sub of val) walkQuery(sub, out, collection); continue; }
    if (key === '$not') { walkQuery(val, out, collection); continue; }
    if (key.startsWith('$')) continue; // other operators: ignore
    resolveFieldValue(key, val, out, collection); // key is a field path (incl. dotted)
  }
}

// Walk a pipeline's stages under a collection context. $match compares against
// `collection`; $unionWith/$lookup recurse with their target collection; $facet
// stays on the same collection. Sub-pipelines with an unknown collection are
// skipped (their fields can't be typed) rather than mis-attributed to `collection`.
function walkPipeline(stages, out, collection) {
  if (!Array.isArray(stages)) return;
  for (const stage of stages) {
    if (!stage || typeof stage !== 'object') continue;
    if (stage.$match) walkQuery(stage.$match, out, collection);
    if (stage.$unionWith && typeof stage.$unionWith === 'object') {
      const uw = stage.$unionWith;
      const coll = typeof uw.coll === 'string' && uw.coll ? uw.coll : null;
      if (coll && Array.isArray(uw.pipeline)) walkPipeline(uw.pipeline, out, coll);
    }
    if (stage.$lookup && typeof stage.$lookup === 'object') {
      const from = typeof stage.$lookup.from === 'string' && stage.$lookup.from ? stage.$lookup.from : null;
      if (from && Array.isArray(stage.$lookup.pipeline)) walkPipeline(stage.$lookup.pipeline, out, from);
    }
    if (stage.$facet && typeof stage.$facet === 'object') {
      for (const sub of Object.values(stage.$facet)) walkPipeline(sub, out, collection);
    }
  }
}

// Map each WHOLE no-modifier placeholder name to the field + collection it is
// compared against, or { ambiguous: true } when one name targets two different
// (field, collection) pairs. Returns {} on parse failure.
export function mapPlaceholdersToFields(text) {
  let parsed;
  try { parsed = JSON5.parse(text); } catch { return {}; }
  if (!Array.isArray(parsed)) return {};
  const out = {};
  walkPipeline(parsed, out, null); // null = active collection
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mdh-placeholder-fields.test.js`
Expected: PASS.

- [ ] **Step 5: Verify no regression**

Run: `npm test`
Expected: All green. `referencedFields` (in `usePipeline.js`) still reads `v.field`/`v.ambiguous`, so it is unaffected by the added `collection` key.

---

### Task 2: Per-collection field types in the editor core

Re-key the `fieldTypes` signal by collection, resolve each placeholder's collection (null → active `selectedCollection`; raw string → substitute `{vars}`), and change `deriveResolvedType` to take a single `fieldTypeInfo` rather than the whole map. This is the coupled core (`fieldTypes.js` + `usePipeline.js` + `DataPanel.jsx` call sites) and lands together to stay green.

**Files:**
- Modify: `src/mdh/fieldTypes.js:53-66` (`deriveResolvedType`)
- Modify: `src/mdh/hooks/usePipeline.js` (imports, `buildResolvedTypes`, `resolvedTypeForName`, `referencedFields`, `ensureFieldTypes`, add `resolveCollectionName`)
- Modify: `src/mdh/components/DataPanel.jsx:106,121,216` (`ensureFieldTypes` call signature)
- Test: `tests/mdh-field-types.test.js`, `tests/mdh-typed-substitution.test.js`

**Interfaces:**
- Produces: `deriveResolvedType(name, { override, fieldMap, fieldTypeInfo, parsedOk }) → { type, source, ... }`. `fieldTypeInfo` is `undefined` (not yet loaded → `detecting`), `null` (loaded, no data → `no-data`), or a `FieldTypeInfo` object.
- Produces: `fieldTypes` signal shape `{ [collectionName]: { [field]: FieldTypeInfo | null } }`.
- Produces: `referencedFields(text) → Array<{ collection, field }>` (collections already resolved to concrete names).
- Produces: `ensureFieldTypes(pairs, resolver?) → Promise<boolean>` where `pairs` is `referencedFields(...)` output.
- Consumes: Task 1's `mapPlaceholdersToFields` entries `{ field, collection, op }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/mdh-field-types.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { deriveResolvedType } from '../src/mdh/fieldTypes.js';

describe('deriveResolvedType — fieldTypeInfo arg', () => {
  const fieldMap = { cust: { field: 'customer_match', collection: '_PROD_material_match', op: '$eq' } };

  it('uses the passed field type info (string wins over numeric-looking value)', () => {
    const info = { dominant: 'string', dominantBson: 'string', share: 1, mixed: false };
    expect(deriveResolvedType('cust', { override: undefined, fieldMap, fieldTypeInfo: info, parsedOk: true }))
      .toMatchObject({ type: 'string', source: 'field' });
  });

  it('override wins over field info', () => {
    const info = { dominant: 'number', dominantBson: 'int', share: 1, mixed: false };
    expect(deriveResolvedType('cust', { override: 'string', fieldMap, fieldTypeInfo: info, parsedOk: true }))
      .toMatchObject({ type: 'string', source: 'override' });
  });

  it('undefined info → detecting; null info → no-data; unmapped → no-field', () => {
    expect(deriveResolvedType('cust', { fieldMap, fieldTypeInfo: undefined, parsedOk: true }))
      .toMatchObject({ type: undefined, source: 'detecting' });
    expect(deriveResolvedType('cust', { fieldMap, fieldTypeInfo: null, parsedOk: true }))
      .toMatchObject({ type: undefined, source: 'no-data' });
    expect(deriveResolvedType('nope', { fieldMap, fieldTypeInfo: undefined, parsedOk: true }))
      .toMatchObject({ type: undefined, source: 'no-field' });
  });
});
```

Add to `tests/mdh-typed-substitution.test.js` (import `usePipeline` via a render harness per repo convention — mirror the existing tests in that file for the setup; the new case):

```js
it('resolves a $unionWith target field type (string) so a numeric-looking ID injects a string', async () => {
  const p = makePipeline(); // existing harness in this file
  const text = JSON.stringify([
    { $match: { _id: '#' } },
    { $unionWith: { coll: '_{prefix}_material_match', pipeline: [
      { $match: { customer_match: '{customer_match}' } },
    ] } },
  ]);
  p.setPlaceholder('prefix', 'PROD');
  p.setPlaceholder('customer_match', '21199417');
  // Simulate the sampler having resolved the target collection's field as string:
  p.fieldTypes.value = { _PROD_material_match: { customer_match: { dominant: 'string', share: 1, mixed: false } } };
  const out = p.substituteWithTypes(text);
  expect(out).toContain('"customer_match": "21199417"');
  expect(out).not.toContain('"customer_match": 21199417');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mdh-field-types.test.js tests/mdh-typed-substitution.test.js`
Expected: FAIL — `deriveResolvedType` still takes `fieldTypes`; `usePipeline` still keys `fieldTypes` flat and ignores `collection`.

- [ ] **Step 3: Update `deriveResolvedType` (`src/mdh/fieldTypes.js:53`)**

Replace the function body:

```js
export function deriveResolvedType(name, { override, fieldMap, fieldTypeInfo, parsedOk }) {
  if (override && override !== 'auto') {
    return PRIMITIVES.has(override) ? { type: override, source: 'override' } : { type: undefined, source: 'no-field' };
  }
  if (!parsedOk) return { type: undefined, source: 'invalid' };
  const m = fieldMap[name];
  if (!m) return { type: undefined, source: 'no-field' };
  if (m.ambiguous) return { type: undefined, source: 'ambiguous' };
  if (fieldTypeInfo === undefined) return { type: undefined, source: 'detecting', field: m.field };
  if (!fieldTypeInfo) return { type: undefined, source: 'no-data', field: m.field };
  if (fieldTypeInfo.dominant === 'other') return { type: undefined, source: 'other', field: m.field, detectedBson: fieldTypeInfo.dominantBson };
  return { type: fieldTypeInfo.dominant, source: fieldTypeInfo.mixed ? 'mixed' : 'field', field: m.field, share: fieldTypeInfo.share, mixed: fieldTypeInfo.mixed };
}
```

- [ ] **Step 4: Update `usePipeline.js` — collection resolution + per-collection lookups**

In `src/mdh/hooks/usePipeline.js`:

1. Extend the store import (line 4) to include `selectedCollection`:
```js
import { skip, selectedCollection } from '../store.js';
```

2. Add a collection-name substituter and resolver near the top of the `usePipeline()` body (after `const { ... } = stateRef.current;`, ~line 149). It closes over `placeholderValues`:
```js
  // Substitute {var} placeholders inside a bare collection-name string (not JSON).
  // Unfilled vars → '' (collection won't resolve → value-based fallback).
  function substituteCollName(raw) {
    return String(raw).replace(VAR_RE_G, (_m, name) => {
      const v = placeholderValues.value[name];
      return v == null ? '' : String(v);
    });
  }
  // Resolve a fieldMap entry's collection: null → the active collection,
  // otherwise the (var-substituted) raw collection string. '' → null.
  function resolveCollectionName(rawColl) {
    if (rawColl == null) return selectedCollection.value || null;
    const resolved = substituteCollName(rawColl);
    return resolved || null;
  }
  // Look up loaded FieldTypeInfo for a resolved (collection, field): undefined
  // if the collection/field pair hasn't been sampled yet, null if sampled with
  // no usable data, else the info object.
  function lookupFieldTypeInfo(coll, field) {
    if (!coll) return undefined;
    const collMap = fieldTypes.value[coll];
    return collMap ? collMap[field] : undefined;
  }
```

3. Replace `buildResolvedTypes` (line 236):
```js
  function buildResolvedTypes(text) {
    const fieldMap = mapPlaceholdersToFields(text);
    const pt = placeholderTypes.value;
    const out = {};
    for (const name of extractPlaceholders(text)) {
      const m = fieldMap[name];
      let fieldTypeInfo;
      if (m && !m.ambiguous) fieldTypeInfo = lookupFieldTypeInfo(resolveCollectionName(m.collection), m.field);
      const d = deriveResolvedType(name, { override: pt[name], fieldMap, fieldTypeInfo, parsedOk: true });
      if (d.type) out[name] = d.type;
    }
    return out;
  }
```

4. Replace `referencedFields` (line 257) — return resolved `{collection, field}` pairs:
```js
  function referencedFields(text) {
    const fm = mapPlaceholdersToFields(text);
    const pairs = [];
    const seen = new Set();
    for (const v of Object.values(fm)) {
      if (!v || !v.field || v.ambiguous) continue;
      const coll = resolveCollectionName(v.collection);
      if (!coll) continue;
      const key = `${coll}::${v.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ collection: coll, field: v.field });
    }
    return pairs;
  }
```

5. Replace `ensureFieldTypes` (line 265) — per-collection fetch, per-collection cache into the signal:
```js
  async function ensureFieldTypes(pairs, resolver = resolveFieldTypes) {
    if (!pairs || pairs.length === 0) return false;
    const byColl = new Map();
    for (const { collection, field } of pairs) {
      const collMap = fieldTypes.value[collection] || {};
      if (field in collMap) continue;
      if (!byColl.has(collection)) byColl.set(collection, []);
      byColl.get(collection).push(field);
    }
    if (byColl.size === 0) return false;
    const next = { ...fieldTypes.value };
    for (const [coll, missing] of byColl) {
      const resolved = await resolver(coll, missing);
      next[coll] = { ...(next[coll] || {}), ...resolved };
    }
    fieldTypes.value = next;
    return true;
  }
```

6. Replace `resolvedTypeForName` (line 278):
```js
  function resolvedTypeForName(name, fieldMap, parsedOk) {
    const override = placeholderTypes.value[name];
    const m = fieldMap[name];
    let fieldTypeInfo;
    if (m && !m.ambiguous) fieldTypeInfo = lookupFieldTypeInfo(resolveCollectionName(m.collection), m.field);
    const effective = deriveResolvedType(name, { override, fieldMap, fieldTypeInfo, parsedOk });
    const auto = override
      ? deriveResolvedType(name, { override: undefined, fieldMap, fieldTypeInfo, parsedOk })
      : effective;
    return { ...effective, autoType: auto.type };
  }
```

- [ ] **Step 5: Update `DataPanel.jsx` `ensureFieldTypes` call sites**

In `src/mdh/components/DataPanel.jsx`, change the three call sites (lines 106, 121, 216) from
`pipeline.ensureFieldTypes(collection, pipeline.referencedFields(<text>))`
to:
```js
pipeline.ensureFieldTypes(pipeline.referencedFields(<text>))
```
(keep each `<text>` argument as-is: `rawText` at 106 and 121, `editorState.text` at 216). `referencedFields` now carries the resolved collection per field, so the standalone `collection` argument is dropped.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/mdh-field-types.test.js tests/mdh-typed-substitution.test.js tests/mdh-resolve-field-types.test.js`
Expected: PASS.

- [ ] **Step 7: Verify no regression + build**

Run: `npm test`
Expected: all green. Fix any test that asserted the old flat `fieldTypes` shape or the old `ensureFieldTypes(collection, fields)` / `deriveResolvedType({fieldTypes})` signatures (update them to the new shapes above).
Run: `npm run build`
Expected: success.

---

### Task 3: Make the value-based guess visible

When Auto falls back to value-based inference (no field resolved), label it "guessed" so the user knows to override. No default change.

**Files:**
- Modify: `src/mdh/components/PlaceholderInputs.jsx:115,134`
- Test: `tests/mdh-placeholder-inputs.test.js`

**Interfaces:**
- Consumes: `resolvedTypeFor(name) → { type, autoType, source }` (Task 2). `autoType` is `undefined` exactly when Auto would fall back to value-based inference.

- [ ] **Step 1: Write the failing test**

Add to `tests/mdh-placeholder-inputs.test.js` (follow the file's existing render harness):

```js
it('labels the Auto option "guessed" when no field type resolved', () => {
  const { container } = renderInputs({
    names: ['cust'], values: { cust: '21199417' }, types: {},
    resolvedTypeFor: () => ({ type: undefined, autoType: undefined }),
  });
  const autoOpt = container.querySelector('.placeholder-type-select option[value="auto"]');
  expect(autoOpt.textContent).toBe('Auto (Number, guessed)');
});

it('does NOT say guessed when a field type resolved', () => {
  const { container } = renderInputs({
    names: ['cust'], values: { cust: '21199417' }, types: {},
    resolvedTypeFor: () => ({ type: 'string', autoType: 'string' }),
  });
  const autoOpt = container.querySelector('.placeholder-type-select option[value="auto"]');
  expect(autoOpt.textContent).toBe('Auto (String)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-placeholder-inputs.test.js`
Expected: FAIL — label has no "guessed" suffix.

- [ ] **Step 3: Implement the label suffix**

In `src/mdh/components/PlaceholderInputs.jsx`, after line 115 (`const autoLabelType = ...`), add:
```js
        const autoGuessed = !rt.autoType; // Auto would fall back to value-based inference
```
Then change the Auto option label (line 134) from
```js
{opt === 'auto' ? `Auto (${CAP[autoLabelType]})` : CAP[opt]}
```
to:
```js
{opt === 'auto' ? `Auto (${CAP[autoLabelType]}${autoGuessed ? ', guessed' : ''})` : CAP[opt]}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mdh-placeholder-inputs.test.js`
Expected: PASS.

- [ ] **Step 5: Verify no regression + build**

Run: `npm test` then `npm run build`
Expected: green + success. (Existing "Auto (X)" assertions in `mdh-placeholder-inputs-render.test.js` that used field-resolved types keep passing; update any that used a value-based case to expect the ", guessed" suffix.)

---

### Task 4: Provenance schema types (pure helpers)

Read a queue's schema and produce authoritative `{schema_id → 'number'|'string'}`; provide a merge helper (schema wins over the `normalized_value` heuristic).

**Files:**
- Modify: `src/popup/mdh-provenance.js`
- Test: `tests/mdh-provenance.test.js`

**Interfaces:**
- Produces: `buildSchemaTypes(content) → { [schema_id]: 'number' | 'string' }` (`'number'` iff `type==='number'` or (`type==='enum'` && `enum_value_type==='number'`)).
- Produces: `mergeSchemaTypes(heuristicTypes, schemaTypes) → merged` (schema wins per field; heuristic fills the rest).
- Produces: `loadSchemaTypesForQueue(domain, token, queueId) → Promise<{ [schema_id]: 'number'|'string' }>` (`{}` on failure).

- [ ] **Step 1: Write the failing tests**

Add to `tests/mdh-provenance.test.js`:

```js
import { buildSchemaTypes, mergeSchemaTypes } from '../src/popup/mdh-provenance.js';

describe('buildSchemaTypes', () => {
  it('maps number and number-enum to number, everything else to string', () => {
    const content = [
      { category: 'section', children: [
        { category: 'datapoint', id: 'amount', type: 'number' },
        { category: 'datapoint', id: 'cust', type: 'enum', enum_value_type: 'string' },
        { category: 'datapoint', id: 'code', type: 'enum', enum_value_type: 'number' },
        { category: 'datapoint', id: 'name', type: 'string' },
        { category: 'datapoint', id: 'when', type: 'date' },
        { category: 'multivalue', id: 'items', children: { category: 'tuple', children: [
          { category: 'datapoint', id: 'item_qty', type: 'number' },
          { category: 'datapoint', id: 'item_desc', type: 'string' },
        ] } },
      ] },
    ];
    expect(buildSchemaTypes(content)).toEqual({
      amount: 'number', cust: 'string', code: 'number', name: 'string',
      when: 'string', item_qty: 'number', item_desc: 'string',
    });
  });
  it('tolerates non-array input', () => {
    expect(buildSchemaTypes(null)).toEqual({});
  });
});

describe('mergeSchemaTypes', () => {
  it('schema wins; heuristic fills fields the schema does not cover', () => {
    expect(mergeSchemaTypes({ a: 'number', b: 'number' }, { b: 'string', c: 'number' }))
      .toEqual({ a: 'number', b: 'string', c: 'number' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mdh-provenance.test.js`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `src/popup/mdh-provenance.js`**

Add (near the placeholder-substitution section):

```js
// Walk a queue schema's `content` tree and classify each datapoint's placeholder
// type. MDH substitution only distinguishes number-vs-string.
export function buildSchemaTypes(content) {
  const out = {};
  const walk = (nodes) => {
    if (Array.isArray(nodes)) { for (const n of nodes) walkNode(n); return; }
    if (nodes && typeof nodes === 'object') walkNode(nodes);
  };
  const walkNode = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.category === 'datapoint' && node.id) {
      const isNumber = node.type === 'number'
        || (node.type === 'enum' && node.enum_value_type === 'number');
      out[node.id] = isNumber ? 'number' : 'string';
    }
    if (node.children != null) walk(node.children);
  };
  walk(content);
  return out;
}

// Schema types are authoritative; the normalized_value heuristic fills any field
// the schema does not cover (or when the schema fetch failed → schemaTypes {}).
export function mergeSchemaTypes(heuristicTypes, schemaTypes) {
  return { ...(heuristicTypes || {}), ...(schemaTypes || {}) };
}

// Fetch a queue's schema and classify its datapoint types. Best-effort: any
// failure (403/offline/missing schema) yields {} so callers fall back to the
// heuristic.
export async function loadSchemaTypesForQueue(domain, token, queueId) {
  try {
    const queue = await fetchJson(`${domain}/api/v1/queues/${queueId}?fields=schema`, token);
    const schemaUrl = queue?.schema;
    if (!schemaUrl) return {};
    const schema = await fetchJson(`${schemaUrl}?fields=content`, token);
    return buildSchemaTypes(schema?.content || []);
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mdh-provenance.test.js`
Expected: PASS.

- [ ] **Step 5: Verify no regression**

Run: `npm test`
Expected: green.

---

### Task 5: Wire schema types into the Provenance panel (cached)

Fetch schema types per queue (5-min session cache) and merge them (schema-first) into the `types` the panel already computes and passes to `ConfigBlock`.

**Files:**
- Modify: `src/popup/cache.js`
- Modify: `src/popup/components/MdhProvenancePanel.jsx` (imports; state build ~line 143-203)
- Test: `tests/mdh-cache.test.js`

**Interfaces:**
- Produces: `getCachedSchemaTypes(domain, queueId) → Promise<map|null>`, `setCachedSchemaTypes(domain, queueId, map) → Promise<void>` (5-min TTL, `chrome.storage.session`).
- Consumes: `loadSchemaTypesForQueue`, `mergeSchemaTypes` (Task 4).

- [ ] **Step 1: Write the failing test**

Add to `tests/mdh-cache.test.js` (mirror existing hook-entries cache tests, incl. the `chrome.storage.session` mock in `tests/setup.js`):

```js
import { getCachedSchemaTypes, setCachedSchemaTypes } from '../src/popup/cache.js';

it('round-trips schema types per (domain, queue) within TTL', async () => {
  await setCachedSchemaTypes('https://d', '7', { cust: 'string' });
  expect(await getCachedSchemaTypes('https://d', '7')).toEqual({ cust: 'string' });
  expect(await getCachedSchemaTypes('https://d', '8')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-cache.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Add the cache to `src/popup/cache.js`**

```js
// ── Schema types (per queue) ──
const SCHEMA_PREFIX = 'mdhProv:schemaTypes:v1:';
const schemaKey = (domain, queueId) => `${SCHEMA_PREFIX}${domain}#${queueId}`;

export async function getCachedSchemaTypes(domain, queueId) {
  if (!queueId) return null;
  const key = schemaKey(domain, queueId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry?.fetchedAt) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.types;
}

export async function setCachedSchemaTypes(domain, queueId, types) {
  if (!queueId) return;
  await chrome.storage.session.set({
    [schemaKey(domain, queueId)]: { types, fetchedAt: Date.now() },
  });
}
```

- [ ] **Step 4: Wire into `MdhProvenancePanel.jsx`**

1. Add to the `../mdh-provenance.js` import block: `loadSchemaTypesForQueue,` and `mergeSchemaTypes,`.
2. Add to the `../cache.js` import block: `getCachedSchemaTypes,` and `setCachedSchemaTypes,`.
3. After `types` is finalized from the annotation (right before the `resolvedEntries` block, ~line 179), merge schema types over it:
```js
        // Schema types are authoritative (they mirror what MDH actually injects);
        // the normalized_value heuristic above fills anything the schema misses.
        let schemaTypes = await getCachedSchemaTypes(ctx.domain, queueId);
        if (!schemaTypes) {
          schemaTypes = await loadSchemaTypesForQueue(ctx.domain, ctx.token, queueId);
          setCachedSchemaTypes(ctx.domain, queueId, schemaTypes).catch(() => {});
        }
        if (cancelled) return;
        types = mergeSchemaTypes(types, schemaTypes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mdh-cache.test.js tests/mdh-provenance.test.js`
Expected: PASS.

- [ ] **Step 6: Verify no regression + build**

Run: `npm test` then `npm run build`
Expected: green + success. (When the schema fetch fails, `mergeSchemaTypes(types, {})` equals the prior `types` — behavior unchanged.)

---

### Task 6: Propagate variable types from Provenance into the editor tab (producer)

When opening a query in a new tab, stage the resolved per-placeholder types alongside the values.

**Files:**
- Modify: `src/popup/mdh-provenance.js` (add `buildVariableTypes` helper)
- Modify: `src/popup/components/ConfigBlock.jsx:133-148` (`openQuery`)
- Modify: `src/popup/components/MdhProvenancePanel.jsx:315-323` (`onOpenInDm`)
- Test: `tests/mdh-provenance.test.js`

**Interfaces:**
- Produces: `buildVariableTypes(placeholders, types) → { [name]: 'number' | 'string' }` — explicit per placeholder (`types[name] === 'number' ? 'number' : 'string'`).
- Produces: `onOpenInDm(dataset, pipelineText, variables, variableTypes)` (4th arg).

- [ ] **Step 1: Write the failing test**

Add to `tests/mdh-provenance.test.js`:

```js
import { buildVariableTypes } from '../src/popup/mdh-provenance.js';

describe('buildVariableTypes', () => {
  it('emits explicit number/string per placeholder from the merged types map', () => {
    expect(buildVariableTypes(['cust', 'amount', 'unknown'], { amount: 'number' }))
      .toEqual({ cust: 'string', amount: 'number', unknown: 'string' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mdh-provenance.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Add `buildVariableTypes` to `src/popup/mdh-provenance.js`**

```js
// Explicit per-placeholder type map for the editor tab. Explicit 'string' (not
// omission) so the editor treats it as an authoritative override and reproduces
// the Provenance replay exactly.
export function buildVariableTypes(placeholders, types) {
  const out = {};
  const t = types || {};
  for (const name of placeholders) out[name] = t[name] === 'number' ? 'number' : 'string';
  return out;
}
```

- [ ] **Step 4: Update `ConfigBlock.openQuery` (`src/popup/components/ConfigBlock.jsx:133`)**

Add the import (top of file, alongside other `mdh-provenance` imports): `buildVariableTypes,`. Then replace `openQuery`:
```js
  const openQuery = (i) => {
    const q = cfg.queries[i];
    const pipeline = queryToPipeline(q.raw);
    if (!pipeline) return;
    // Keep placeholders verbatim so the editor shows them as live variables.
    // Pass the current row's values AND the resolved types so the editor
    // reproduces this replay exactly (types propagate, not just values).
    const values = valuesForCurrentRow();
    const variables = {};
    for (const name of q.placeholders) {
      if (name in values) variables[name] = String(values[name]);
    }
    const variableTypes = buildVariableTypes(q.placeholders, types);
    onOpenInDm(cfg.dataset, JSON.stringify(pipeline, null, 2), variables, variableTypes);
  };
```

- [ ] **Step 5: Update `onOpenInDm` in `MdhProvenancePanel.jsx:315`**

```js
                  onOpenInDm={(dataset, pipelineText, variables, variableTypes) =>
                    openConsoleTab(tab, {
                      token: state.ctx.token,
                      domain: state.ctx.domain,
                      pendingCollection: dataset,
                      pendingPipeline: pipelineText,
                      pendingVariables: variables,
                      pendingVariableTypes: variableTypes,
                    }, 'mdh')
                  }
```

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run tests/mdh-provenance.test.js` (PASS), then `npm test` (green), then `npm run build` (success).

---

### Task 7: Consume propagated types on boot

Carry `pendingVariableTypes` through boot into `pendingPipelineLoad.placeholderTypes`, which `DataPanel` already applies (`DataPanel.jsx:158`).

**Files:**
- Modify: `src/console/boot.js:20-41` (`resolveBootAuth`)
- Modify: `src/mdh/index.jsx:112,155-165` (`initMdh`)
- Modify: `src/mdh/store.js:40` (shape comment)
- Test: `tests/console-boot.test.js`

**Interfaces:**
- Produces: `resolveBootAuth(...).pendingCtx.pendingVariableTypes`.
- Produces: `initMdh({ ..., pendingVariableTypes })` → `pendingPipelineLoad.placeholderTypes`.

- [ ] **Step 1: Write the failing test**

Add to `tests/console-boot.test.js`:

```js
it('resolveBootAuth carries pendingVariableTypes from the staging entry', () => {
  const entry = {
    token: 't', domain: 'd', app: 'mdh',
    pendingCollection: 'C', pendingPipeline: '[]',
    pendingVariables: { cust: '21199417' },
    pendingVariableTypes: { cust: 'string' },
  };
  const r = resolveBootAuth({ entry, session: {} });
  expect(r.pendingCtx.pendingVariableTypes).toEqual({ cust: 'string' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/console-boot.test.js`
Expected: FAIL — `pendingVariableTypes` not in `pendingCtx`.

- [ ] **Step 3: Update `resolveBootAuth` (`src/console/boot.js:27-31`)**

Add the field to the `pendingCtx` object:
```js
      pendingCtx: {
        pendingCollection: entry.pendingCollection,
        pendingPipeline: entry.pendingPipeline,
        pendingVariables: entry.pendingVariables,
        pendingVariableTypes: entry.pendingVariableTypes,
      },
```

- [ ] **Step 4: Update `initMdh` (`src/mdh/index.jsx:112,159-164`)**

Change the signature (line 112):
```js
export async function initMdh({ pendingCollection, pendingPipeline, pendingVariables, pendingVariableTypes } = {}) {
```
And the `pendingPipelineLoad` assignment (line 160):
```js
      store.pendingPipelineLoad.value = {
        collection: pendingCollection,
        pipelineText: pendingPipeline,
        variables: pendingVariables || undefined,
        placeholderTypes: pendingVariableTypes || undefined,
      };
```
Confirm the boot caller (`src/console/index.jsx`, where `initMdh` is invoked with `pendingCtx`) spreads `pendingCtx`, so `pendingVariableTypes` flows through. If it passes fields explicitly, add `pendingVariableTypes`.

- [ ] **Step 5: Update the shape comment (`src/mdh/store.js:40`)**

```js
export const pendingPipelineLoad = signal(null); // { collection, pipelineText, variables?, placeholderTypes? } | null
```

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run tests/console-boot.test.js` (PASS), then `npm test` (green), then `npm run build` (success).

---

### Task 8: Full regression, build, and live dogfood

Confirm the whole feature end-to-end; nothing regresses.

**Files:** none (verification only).

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all green, count ≥ 1785 (new tests added). If any legacy test asserted an old signature/shape, it was updated in the relevant task above — re-confirm none remain red.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success, `dist/` produced.

- [ ] **Step 3: Ask the user to reload the extension and dogfood**

Provide this checklist for the user (the loaded extension runs `dist/`):
- In Dataset Management, paste the reported pipeline against a collection whose `$unionWith` target stores the ID as a string, fill the variables, run → the ID variable shows "Auto (String)" (or resolves via sampling) and the query returns the expected row (not empty).
- A genuine number field (e.g. an amount compared in a top-level `$match`) still injects a number and matches.
- From the popup MDH Provenance panel, click "Open in Dataset Management" on a query whose placeholder is a numeric-string enum → the new tab opens with that variable typed as String and returns rows.
- A variable with no resolvable field shows "Auto (Number, guessed)" for a numeric value.
- Provenance replay still works when the queue schema request 403s (types fall back to the `normalized_value` heuristic).

---

## Self-Review

**Spec coverage:**
- Component 1 (Provenance schema types) → Tasks 4, 5. ✓
- Component 2 (propagation bridge) → Tasks 6, 7. ✓
- Component 3 (editor collection-aware sampling) → Tasks 1, 2; visible guess → Task 3. ✓
- Precedence (override/propagated > field-sample > value-based) → Task 2 (`deriveResolvedType`) + Task 7 (propagated types land as overrides). ✓
- Backward compat (schema-fetch failure = today's behavior; value default unchanged; top-level `$match` unchanged) → Tasks 5, 3, 1. ✓
- Testing (unit per module + regression + dogfood) → every task + Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows real assertions.

**Type consistency:** `deriveResolvedType({ override, fieldMap, fieldTypeInfo, parsedOk })` used identically in `buildResolvedTypes` and `resolvedTypeForName` (Task 2). `fieldTypes` signal `{collection:{field:info}}` consistent across `lookupFieldTypeInfo`, `ensureFieldTypes`, tests. `referencedFields` → `Array<{collection,field}>` matches `ensureFieldTypes(pairs)`. `onOpenInDm(dataset, pipelineText, variables, variableTypes)` matches the `ConfigBlock` caller and `MdhProvenancePanel` handler. `pendingVariableTypes` name consistent across producer → boot → `initMdh` → `pendingPipelineLoad.placeholderTypes` (which `DataPanel.jsx:158` already applies).
