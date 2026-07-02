# MDH Import Redesign (Data-Matching API + Shape Validation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route MDH import Update/Replace through the Rossum data-matching API (server-side upsert-by-`id_keys` / whole-dataset replace) while keeping Insert on Data Storage, and add a client-side shape guard.

**Architecture:** The import wizard becomes a router: **Insert** → Data Storage `insert_many` (unchanged); **Update** → `PATCH /svc/data-matching/api/v1/dataset/{name}` (multipart JSON + `id_keys` + `update_or_new=true`); **Replace** → `PUT …/dataset/{name}`. All input formats parse to JS objects then serialize to a JSON blob for upload (type fidelity). Update/Replace are async (202 + `Location` op id, poll to `finished`). A new pure `shape.js` derives the existing collection's deep field-names+types and blocks imports whose docs don't match exactly (toggle to disable; non-uniform data → warn).

**Tech Stack:** Preact + @preact/signals, esbuild (IIFE, classic JSX pragma `h`), Vitest + jsdom, native `fetch`/`FormData`.

## Global Constraints

- **Build:** esbuild only, classic JSX pragma `h`/`Fragment`. Run `npm run build` after UI changes.
- **Tests:** Vitest, `tests/**/*.test.js`; DOM tests start `// @vitest-environment jsdom`; mount `h(Component, props)` + Preact `render`; condition-based `waitFor`, never fixed sleeps. One file: `npx vitest run tests/<name>.test.js`; full: `npm test`.
- **JSX unicode:** `\uXXXX` does NOT work in JSX text/attrs — use `{'…'}`/`{'—'}`/`{'→'}` expressions or the literal char. Fine in JS strings/template literals.
- **API bases (verified live 2026-07-01):** data-matching = `${baseDomain}/svc/data-matching/api/v1`; op status GET `…/operation/{id}` returns the operation object **at top level** (no `{result}` wrapper) with **lowercase** `status` (`processing|finished|failed|unknown|new|queued`). Writes return `202` + `Location` header whose last path segment is the operation id. Multipart fields: `file`*, `encoding`* (`utf-8`); PATCH adds repeated `id_keys` + `update_or_new`; PUT is plain. Upload **JSON** (types preserved; CSV → strings). `_id` is server-assigned; MDH injects `__digest_md5`. Datasets == the Data Storage collections the app lists.
- **Type taxonomy (shape):** `'string' | 'number' | 'bool' | 'null' | 'array' | 'object' | 'objectId' | 'date'`. `{$oid:…}`→`objectId`, `{$date:…}`→`date`; arrays are a leaf `array` (not element-walked); nested plain objects are walked to dotted paths.
- **Shape rule:** exact field-set match per doc (no missing, no extra), types must agree; **`null` is type-compatible in both directions**. Guards all three modes. Toggle default ON (`mdhImportValidateShape`); off → skip. Empty/new collection (no reference) → skip.
- **Backward compatibility:** reused components keep props/testids where noted (`MatchKeyPicker` `match-keys`/`match-key-input`/`match-key-suggest`, wizard `import-source`/`import-mode`/`import-go`/`import-plan`). Insert behavior unchanged.
- **Commits:** the owner defers commits. Treat every "Commit" step as **"stage + checkpoint for review"** — do NOT run `git commit` unless explicitly asked. Stay on `master`; no branches. (Layers on prior uncommitted import work.)

---

## File Structure

- `src/mdh/shape.js` — **NEW**, pure: `typeOf`, `deriveShape`, `validateAgainstShape`.
- `src/mdh/api.js` — **MODIFY**: add `datasetUpdate`, `datasetReplace`, `waitForDatasetOperation` (+ internal multipart helper + op-id/`Location` parse).
- `src/mdh/components/ImportStages.jsx` — **MODIFY**: indeterminate ("processing") progress + server-managed summary.
- `src/mdh/components/ImportConfirm.jsx` — **MODIFY**: mode selector, `id_keys` picker for Update, shape panel + toggle, per-mode summaries; drop old plan/upsert/index props.
- `src/mdh/components/ImportWizard.jsx` — **MODIFY**: routing (Insert→DS, Update/Replace→MDH), shape reference load, JSON serialize, async execute + poll.
- `src/mdh/importPlan.js` — **MODIFY (trim)**: keep `collectFieldPaths`/`getPath`/`hasPath`; the probe/plan machinery becomes unused (removed in the cleanup task once nothing imports it).
- `src/mdh/runImport.js` — **REMOVE** (its Insert path moves to a direct `runChunkedInsert` call; Update/Replace machinery is superseded).
- `src/console/console.css` — **MODIFY**: `.import-shape-*` styles.

Tests: `tests/mdh-shape.test.js` (new), `tests/mdh-api.test.js` (extend), `tests/mdh-import-stages.test.js` (extend/new), `tests/mdh-import-confirm.test.js` (rewrite), `tests/mdh-import-wizard*.test.js` (rewrite), and remove `tests/mdh-run-import*.test.js` / probe-plan tests in the cleanup task.

---

## Task 1: `shape.js` — derive + validate (pure)

**Files:** Create `src/mdh/shape.js`; Test `tests/mdh-shape.test.js`

**Interfaces:**
- Produces:
  - `typeOf(value) → string` (one of the type taxonomy).
  - `deriveShape(docs: object[]) → { paths: Map<string, Set<string>>, uniform: boolean, optionalPaths: string[] }` — `paths` maps each deep dotted path to the set of types seen; `uniform` is true iff every path appears in every doc and each path has exactly one type; `optionalPaths` lists paths absent from at least one doc.
  - `validateAgainstShape(docs: object[], shape) → { ok: boolean, missing: string[], unknown: string[], typeMismatch: {path:string, expected:string[], got:string}[], failedDocCount: number }`.

- [ ] **Step 1: Write failing tests** — create `tests/mdh-shape.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { typeOf, deriveShape, validateAgainstShape } from '../src/mdh/shape.js';

describe('typeOf', () => {
  it('maps primitives, arrays, objects, and EJSON', () => {
    expect(typeOf('x')).toBe('string');
    expect(typeOf(3)).toBe('number');
    expect(typeOf(3.5)).toBe('number');
    expect(typeOf(true)).toBe('bool');
    expect(typeOf(null)).toBe('null');
    expect(typeOf([1, 2])).toBe('array');
    expect(typeOf({ a: 1 })).toBe('object');
    expect(typeOf({ $oid: '6a44fe42106e88484ea73b61' })).toBe('objectId');
    expect(typeOf({ $date: '2026-07-01T00:00:00Z' })).toBe('date');
  });
});

describe('deriveShape', () => {
  it('walks nested paths, treats arrays as leaves, and reports uniform', () => {
    const s = deriveShape([
      { sku: 'A1', price: 10, meta: { active: true }, tags: ['x'] },
      { sku: 'B2', price: 20, meta: { active: false }, tags: [] },
    ]);
    expect([...s.paths.keys()].sort()).toEqual(['meta.active', 'price', 'sku', 'tags']);
    expect(s.paths.get('price')).toEqual(new Set(['number']));
    expect(s.paths.get('tags')).toEqual(new Set(['array']));
    expect(s.uniform).toBe(true);
    expect(s.optionalPaths).toEqual([]);
  });

  it('flags non-uniform when a field is optional or has mixed types', () => {
    const s = deriveShape([
      { sku: 'A1', price: 10 },
      { sku: 'B2', price: '20', note: 'hi' },
    ]);
    expect(s.uniform).toBe(false);
    expect(s.optionalPaths).toContain('note');
    expect(s.paths.get('price')).toEqual(new Set(['number', 'string']));
  });
});

describe('validateAgainstShape', () => {
  const shape = deriveShape([{ sku: 'A1', price: 10, meta: { active: true } }]);

  it('passes when every doc has exactly the reference fields and types', () => {
    const r = validateAgainstShape([{ sku: 'B2', price: 20, meta: { active: false } }], shape);
    expect(r.ok).toBe(true);
    expect(r.failedDocCount).toBe(0);
  });

  it('fails on a missing field', () => {
    const r = validateAgainstShape([{ sku: 'B2', price: 20 }], shape);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('meta.active');
    expect(r.failedDocCount).toBe(1);
  });

  it('fails on an unknown field', () => {
    const r = validateAgainstShape([{ sku: 'B2', price: 20, meta: { active: true }, extra: 1 }], shape);
    expect(r.ok).toBe(false);
    expect(r.unknown).toContain('extra');
  });

  it('fails on a type conflict', () => {
    const r = validateAgainstShape([{ sku: 'B2', price: '20', meta: { active: true } }], shape);
    expect(r.ok).toBe(false);
    expect(r.typeMismatch.map((t) => t.path)).toContain('price');
  });

  it('treats null as compatible in both directions', () => {
    const r1 = validateAgainstShape([{ sku: 'B2', price: null, meta: { active: true } }], shape);
    expect(r1.ok).toBe(true);
    const nullShape = deriveShape([{ sku: 'A1', price: null, meta: { active: true } }]);
    const r2 = validateAgainstShape([{ sku: 'B2', price: 20, meta: { active: false } }], nullShape);
    expect(r2.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-shape.test.js` (module not found).

- [ ] **Step 3: Implement** — create `src/mdh/shape.js`:
```js
// Pure shape derivation + validation for the import wizard's shape guard.
// "Shape" = the set of deep (dotted) field paths in the existing records, plus
// the type(s) seen at each path. Arrays are a single leaf type ('array'); plain
// nested objects are walked; the EJSON wrappers {$oid}/{$date} are their own
// types. Validation is an EXACT field-set match per document (no missing, no
// extra), with types required to agree — except `null`, which is compatible in
// both directions (a field may legitimately be null on either side).

export function typeOf(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$oid') return 'objectId';
    if (keys.length === 1 && keys[0] === '$date') return 'date';
    return 'object';
  }
  return 'string';
}

// Collect { path -> type } for one document. Walks plain objects into dotted
// paths; arrays and EJSON wrappers are leaves. `_id` and MDH's `__digest_md5`
// are ignored (server-owned, not part of the user's data shape).
const IGNORED = new Set(['_id', '__digest_md5']);

function collectPaths(obj, prefix, out) {
  for (const key of Object.keys(obj)) {
    if (!prefix && IGNORED.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const t = typeOf(obj[key]);
    if (t === 'object') collectPaths(obj[key], path, out);
    else out.set(path, t);
  }
  return out;
}

export function deriveShape(docs) {
  const paths = new Map();           // path -> Set<type>
  const presence = new Map();        // path -> count of docs containing it
  const list = Array.isArray(docs) ? docs : [];
  for (const doc of list) {
    if (!doc || typeof doc !== 'object') continue;
    const dp = collectPaths(doc, '', new Map());
    for (const [path, t] of dp) {
      if (!paths.has(path)) paths.set(path, new Set());
      paths.get(path).add(t);
      presence.set(path, (presence.get(path) || 0) + 1);
    }
  }
  const total = list.length;
  const optionalPaths = [...presence.entries()].filter(([, c]) => c < total).map(([p]) => p);
  const uniform = optionalPaths.length === 0 && [...paths.values()].every((s) => s.size === 1);
  return { paths, uniform, optionalPaths };
}

// null is compatible with any type; a reference set containing 'null' accepts any incoming type.
function typeCompatible(refTypes, got) {
  if (got === 'null') return true;
  if (refTypes.has('null')) return true;
  return refTypes.has(got);
}

export function validateAgainstShape(docs, shape) {
  const missing = new Set();
  const unknown = new Set();
  const typeMismatch = new Map(); // path -> {path, expected, got}
  let failedDocCount = 0;
  const refPaths = shape?.paths || new Map();
  const list = Array.isArray(docs) ? docs : [];

  for (const doc of list) {
    let bad = false;
    const dp = (doc && typeof doc === 'object') ? collectPaths(doc, '', new Map()) : new Map();
    for (const [path] of refPaths) {
      if (!dp.has(path)) { missing.add(path); bad = true; }
    }
    for (const [path, got] of dp) {
      if (!refPaths.has(path)) { unknown.add(path); bad = true; continue; }
      if (!typeCompatible(refPaths.get(path), got)) {
        if (!typeMismatch.has(path)) typeMismatch.set(path, { path, expected: [...refPaths.get(path)], got });
        bad = true;
      }
    }
    if (bad) failedDocCount++;
  }
  return {
    ok: missing.size === 0 && unknown.size === 0 && typeMismatch.size === 0,
    missing: [...missing],
    unknown: [...unknown],
    typeMismatch: [...typeMismatch.values()],
    failedDocCount,
  };
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/mdh-shape.test.js`
- [ ] **Step 5: Commit** — `git add src/mdh/shape.js tests/mdh-shape.test.js` (stage only; do NOT commit).

---

## Task 2: data-matching API methods + operation poller

**Files:** Modify `src/mdh/api.js`; Test `tests/mdh-api.test.js`

**Interfaces:**
- Consumes: existing `combinedSignal`, `authHeader`, `baseDomain`, `apiError` in `api.js`.
- Produces:
  - `datasetUpdate(collectionName, file /*Blob|string*/, idKeys /*string[]*/, { signal } = {}) → Promise<{ operationId: string }>` — PATCH multipart.
  - `datasetReplace(collectionName, file, { signal } = {}) → Promise<{ operationId: string }>` — PUT multipart.
  - `waitForDatasetOperation(operationId, { intervalMs = 2000, timeoutMs = 300_000, signal } = {}) → Promise<object>` — resolves the op on `finished`/`unknown`; throws on `failed` (surfacing `error`); `timedOut`/`pollUnavailable` flags on failure modes.

- [ ] **Step 1: Write failing tests** — append to `tests/mdh-api.test.js` (reuse its `ok`/`err` helpers and `beforeEach` that calls `api.init('https://example.rossum.app', 'test-token-123')`):
```js
describe('data-matching dataset API', () => {
  it('datasetReplace PUTs multipart to the data-matching base and returns the op id from Location', async () => {
    fetchMock.mockResolvedValue(ok({ message: 'queued' }, { location: 'https://example.rossum.app/svc/master-data-hub/api/v1/operation/abc123' }));
    const res = await api.datasetReplace('products', '[{"a":1}]');
    expect(res).toEqual({ operationId: 'abc123' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.rossum.app/svc/data-matching/api/v1/dataset/products');
    expect(opts.method).toBe('PUT');
    expect(opts.headers.Authorization).toBe('Bearer test-token-123');
    expect(opts.headers['Content-Type']).toBeUndefined(); // browser sets multipart boundary
    expect(opts.body.get('encoding')).toBe('utf-8');
    expect(opts.body.get('file')).toBeTruthy();
  });

  it('datasetUpdate PATCHes with repeated id_keys and update_or_new', async () => {
    fetchMock.mockResolvedValue(ok({}, { location: '/x/operation/op9' }));
    const res = await api.datasetUpdate('products', '[{"sku":"A1"}]', ['sku', 'region']);
    expect(res.operationId).toBe('op9');
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.method).toBe('PATCH');
    expect(opts.body.getAll('id_keys')).toEqual(['sku', 'region']);
    expect(opts.body.get('update_or_new')).toBe('true');
  });

  it('waitForDatasetOperation resolves on finished (lowercase)', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ status: 'processing' }))
      .mockResolvedValueOnce(ok({ status: 'finished', operation_type: 'replace' }));
    const op = await api.waitForDatasetOperation('op1', { intervalMs: 0 });
    expect(op.status).toBe('finished');
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.rossum.app/svc/data-matching/api/v1/operation/op1');
  });

  it('waitForDatasetOperation throws with the server error on failed', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'failed', error: 'bad file' }));
    await expect(api.waitForDatasetOperation('op2', { intervalMs: 0 })).rejects.toThrow(/bad file/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-api.test.js`

- [ ] **Step 3: Implement** — add to `src/mdh/api.js` (after the existing `waitForOperation`/`healthz` block; reuses `combinedSignal`, `authHeader`, `baseDomain`, `apiError`):
```js
// ---- MDH data-matching dataset API (server-side upsert / whole-dataset replace) ----
// Distinct service from Data Storage: {baseDomain}/svc/data-matching/api/v1.
// Writes are multipart file uploads returning 202 + a `Location` op-status URL
// whose last path segment is the operation id. Uploads are JSON (type fidelity).
function dmBase() { return `${baseDomain}/svc/data-matching/api/v1`; }

function opIdFromLocation(res) {
  const loc = res.headers?.get?.('location') || res.headers?.get?.('content-location') || '';
  const m = loc.match(/\/operation\/([^/?#\s]+)/i);
  return m ? m[1] : null;
}

async function dmWrite(method, collectionName, form, externalSignal) {
  const { signal, timer } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(`${dmBase()}/dataset/${encodeURIComponent(collectionName)}`, {
      method,
      headers: { Authorization: authHeader }, // NO Content-Type: browser sets the multipart boundary
      body: form,
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      if (externalSignal?.aborted) throw err;
      throw new Error('Request timed out after 30s');
    }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) throw apiError('Session expired. Open a Rossum page and click Data Storage again to reconnect.', 401);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiError(data?.message || `API error ${res.status}`, res.status);
  const operationId = opIdFromLocation(res);
  if (!operationId) throw apiError('No operation id in dataset response', res.status);
  return { operationId };
}

function jsonFilePart(file) {
  // Accept a Blob (already built by the caller) or a JSON string.
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  return new Blob([typeof file === 'string' ? file : JSON.stringify(file)], { type: 'application/json' });
}

export function datasetReplace(collectionName, file, { signal } = {}) {
  const form = new FormData();
  form.append('file', jsonFilePart(file), 'data.json');
  form.append('encoding', 'utf-8');
  return dmWrite('PUT', collectionName, form, signal);
}

export function datasetUpdate(collectionName, file, idKeys, { signal } = {}) {
  const form = new FormData();
  form.append('file', jsonFilePart(file), 'data.json');
  form.append('encoding', 'utf-8');
  form.append('update_or_new', 'true');
  for (const k of (idKeys || [])) form.append('id_keys', k);
  return dmWrite('PATCH', collectionName, form, signal);
}

// Poll a data-matching operation to a terminal state. Resolves the op on
// `finished` (and on `unknown`, treated as terminal-uncertain); throws on
// `failed` surfacing `error`. Tolerant of a few transient poll failures.
export async function waitForDatasetOperation(operationId, { intervalMs = 2000, timeoutMs = 300_000, signal } = {}) {
  const start = Date.now();
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('Operation polling aborted');
    let op;
    try {
      const { signal: reqSignal, timer } = combinedSignal(signal);
      const res = await fetch(`${dmBase()}/operation/${encodeURIComponent(operationId)}`, { headers: { Authorization: authHeader }, signal: reqSignal });
      clearTimeout(timer);
      op = await res.json().catch(() => ({}));
      consecutiveErrors = 0;
    } catch (err) {
      if (++consecutiveErrors >= 5 || Date.now() - start > timeoutMs) {
        const e = new Error(`Could not check operation ${operationId}: ${err.message}`);
        e.pollUnavailable = true;
        throw e;
      }
      await new Promise((r) => { setTimeout(r, intervalMs); });
      continue;
    }
    if (op.status === 'finished' || op.status === 'unknown') return op;
    if (op.status === 'failed') throw new Error(op.error || `Operation ${operationId} failed`);
    if (Date.now() - start > timeoutMs) {
      const e = new Error(`Operation ${operationId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
      e.timedOut = true;
      throw e;
    }
    await new Promise((r) => { setTimeout(r, intervalMs); });
  }
}
```

- [ ] **Step 4: Run, expect PASS + build** — `npx vitest run tests/mdh-api.test.js` then `npm run build`
- [ ] **Step 5: Commit** — `git add src/mdh/api.js tests/mdh-api.test.js` (stage only).

---

## Task 3: ImportStages — indeterminate progress + server-managed summary

**Files:** Modify `src/mdh/components/ImportStages.jsx`; Test `tests/mdh-import-stages.test.js` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ImportProgress` also renders an **indeterminate** bar when `progress.indeterminate` is truthy (phases `uploading`/`processing`), showing only a message + animated bar (no counts). `ImportSummary` also renders a **server-managed** result: `{ kind:'update'|'replace', sent:number, serverManaged:true, ok:true, cancelled?:false }` → a single line "Uploaded N rows — server updated/replaced the collection."

- [ ] **Step 1: Write failing tests** — create/append `tests/mdh-import-stages.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import { ImportProgress, ImportSummary } from '../src/mdh/components/ImportStages.jsx';

function mount(vnode) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }

describe('ImportProgress indeterminate', () => {
  it('renders a processing message and no numeric counts when indeterminate', () => {
    const root = mount(h(ImportProgress, { progress: { phase: 'processing', indeterminate: true } }));
    expect(root.textContent).toMatch(/processing/i);
    expect(root.querySelector('.import-progress-counts')).toBeNull();
  });
});

describe('ImportSummary server-managed', () => {
  it('shows the uploaded row count for a server-managed update', () => {
    const root = mount(h(ImportSummary, { result: { kind: 'update', sent: 42, serverManaged: true, ok: true, failedBatches: [] }, fileMeta: { name: 'f.json' }, onClose() {} }));
    expect(root.textContent).toMatch(/42/);
    expect(root.textContent).toMatch(/updated|upsert/i);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-stages.test.js`

- [ ] **Step 3: Implement** — in `src/mdh/components/ImportStages.jsx`:

Replace the `ImportProgress` function body's `LABELS`/return with an indeterminate branch:
```jsx
export function ImportProgress({ progress, onCancel }) {
  const { phase, processed = 0, total = 0, indeterminate } = progress;
  const LABELS = { analyze: 'Analyzing', insert: 'Inserting', update: 'Updating', replace: 'Replacing', delete: 'Deleting', uploading: 'Uploading', processing: 'Processing on the server' };
  const label = LABELS[phase] || 'Working';
  if (indeterminate) {
    return (
      <Fragment>
        <div class="modal-message">{label}{'…'}</div>
        <div class="import-progress"><div class="import-progress-track"><div class="import-progress-fill indeterminate"></div></div></div>
        <div class="input-hint">This can take up to a minute.</div>
        {onCancel && <div class="modal-actions"><button class="btn btn-secondary" onClick={onCancel}>Cancel</button></div>}
      </Fragment>
    );
  }
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  return (
    <Fragment>
      <div class="modal-message">{label}{'…'}</div>
      <div class="import-progress">
        <div class="import-progress-track"><div class="import-progress-fill" style={`width:${pct}%`}></div></div>
        <div class="import-progress-counts"><span>{processed.toLocaleString()} / {total.toLocaleString()}</span><span>{pct}%</span></div>
      </div>
      {onCancel && (<div class="modal-actions"><button class="btn btn-secondary" onClick={onCancel}>Cancel</button></div>)}
    </Fragment>
  );
}
```

In `ImportSummary`, add a server-managed branch at the top of the function (before the existing destructure logic), keeping the rest for Insert/overwrite:
```jsx
export function ImportSummary({ result, fileMeta, onClose }) {
  if (result.serverManaged) {
    const verb = result.kind === 'replace' ? 'replaced' : 'updated';
    return (
      <Fragment>
        <div class="import-result-header success">
          <span class="import-result-icon">{'✓'}</span>
          <span>Import complete{fileMeta?.name && <span class="import-result-filename"> {'·'} {fileMeta.name}</span>}</span>
        </div>
        <ul class="import-result-list">
          <li>Uploaded <strong>{(result.sent || 0).toLocaleString()}</strong> row{result.sent === 1 ? '' : 's'} {'—'} the server {verb} the collection.</li>
        </ul>
        <div class="modal-actions"><button class="btn btn-primary" onClick={onClose}>Close</button></div>
      </Fragment>
    );
  }
  const { kind, applied = 0, inserted = 0, deleted = 0, skipped = 0, failedBatches = [], cancelled } = result;
  // …existing body unchanged…
```

- [ ] **Step 4: Add CSS** — append to `src/console/console.css`:
```css
.import-progress-fill.indeterminate { width: 40%; border-radius: inherit; animation: import-indet 1.1s ease-in-out infinite; }
@keyframes import-indet { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
```

- [ ] **Step 5: Run, expect PASS + build** — `npx vitest run tests/mdh-import-stages.test.js` then `npm run build`
- [ ] **Step 6: Commit** — stage `src/mdh/components/ImportStages.jsx src/console/console.css tests/mdh-import-stages.test.js`.

---

## Task 4: ImportConfirm — modes, id_keys picker, shape panel + toggle

**Files:** Modify `src/mdh/components/ImportConfirm.jsx`; Test `tests/mdh-import-confirm.test.js` (rewrite)

**Interfaces:**
- Consumes: `MatchKeyPicker` (`{ paths, keys, setKeys }`), `collectFieldPaths` (from `importPlan.js`), `analyzeDocs` (from `importFile.js`), `validateAgainstShape` (from `shape.js`), shared `Segmented`/`Toggle` (from `ImportControls.jsx`).
- Produces: `ImportConfirm` with **new props** `{ fileMeta, docs, mode, setMode, keys, setKeys, validateShape, setValidateShape, shape, shapeLoading, onImport, onCancel }`. Keeps `data-testid="import-plan"` on the summary, `data-testid="import-go"` on the button, `data-testid="import-mode"` on the mode control. Exports `defaultKeysFor(docs)` unchanged.

- [ ] **Step 1: Write failing tests** — rewrite `tests/mdh-import-confirm.test.js`:
```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import ImportConfirm from '../src/mdh/components/ImportConfirm.jsx';
import { deriveShape } from '../src/mdh/shape.js';

function mount(vnode) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }
const docs = [{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20 }];
const base = { fileMeta: { name: 'f.json' }, docs, mode: 'insert', setMode() {}, keys: [], setKeys() {}, validateShape: false, setValidateShape() {}, shape: null, shapeLoading: false, onImport() {}, onCancel() {} };

describe('ImportConfirm', () => {
  it('insert summary counts new documents and enables Go', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert' }));
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/new document/i);
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(false);
  });

  it('update requires match keys (Go disabled until a key is chosen)', () => {
    const noKeys = mount(h(ImportConfirm, { ...base, mode: 'update', keys: [] }));
    expect(noKeys.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    const withKeys = mount(h(ImportConfirm, { ...base, mode: 'update', keys: ['sku'] }));
    expect(withKeys.querySelector('[data-testid="import-go"]').disabled).toBe(false);
    expect(withKeys.querySelector('[data-testid="import-plan"]').textContent).toMatch(/upsert|match/i);
  });

  it('replace summary warns it replaces the whole collection', () => {
    const root = mount(h(ImportConfirm, { ...base, mode: 'replace' }));
    expect(root.querySelector('[data-testid="import-plan"]').textContent).toMatch(/entire collection|whole collection/i);
  });

  it('blocks Go when shape validation is on and docs do not match', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10, region: 'EU' }]); // requires region
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', validateShape: true, shape }));
    expect(root.querySelector('[data-testid="import-go"]').disabled).toBe(true);
    expect(root.querySelector('[data-testid="import-shape"]').textContent).toMatch(/region/);
  });

  it('warns (does not hard-block beyond validation) when existing data is non-uniform', () => {
    const shape = deriveShape([{ sku: 'A1', price: 10 }, { sku: 'B2', price: 20, note: 'x' }]); // note optional -> non-uniform
    const root = mount(h(ImportConfirm, { ...base, mode: 'insert', validateShape: true, shape }));
    expect(root.querySelector('[data-testid="import-shape"]').textContent).toMatch(/uniform/i);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-confirm.test.js`

- [ ] **Step 3: Implement** — replace the entire contents of `src/mdh/components/ImportConfirm.jsx`:
```jsx
import { h, Fragment } from 'preact';
import { useMemo } from 'preact/hooks';
import { analyzeDocs } from '../importFile.js';
import { collectFieldPaths } from '../importPlan.js';
import { validateAgainstShape } from '../shape.js';
import { Segmented, Toggle } from './ImportControls.jsx';
import { formatBytes } from './ImportStages.jsx';
import MatchKeyPicker from './MatchKeyPicker.jsx';

const MODE_SEG = [
  { value: 'insert', label: 'Insert' },
  { value: 'update', label: 'Update' },
  { value: 'replace', label: 'Replace' },
];

export function defaultKeysFor(docs) {
  if (!docs || docs.length === 0) return [];
  const allHaveId = docs.every((d) => d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, '_id'));
  return allHaveId ? ['_id'] : [];
}

function pluralDocs(n) { return `${n.toLocaleString()} document${n === 1 ? '' : 's'}`; }

export default function ImportConfirm({
  fileMeta, docs, mode, setMode, keys, setKeys,
  validateShape, setValidateShape, shape, shapeLoading, onImport, onCancel,
}) {
  const isUpdate = mode === 'update';
  const isReplace = mode === 'replace';

  const insertStats = mode === 'insert' ? analyzeDocs(docs) : null;
  const insertCount = insertStats ? insertStats.uniqueIdCount + insertStats.withoutId : 0;
  const fieldPaths = useMemo(() => collectFieldPaths(docs), [docs]);

  // Shape check: only when the toggle is on and we have a reference shape
  // (empty/new collections have none -> skipped).
  const shapeCheck = useMemo(() => {
    if (!validateShape || !shape) return null;
    return validateAgainstShape(docs, shape);
  }, [validateShape, shape, docs]);
  const shapeOk = !shapeCheck || shapeCheck.ok;

  let canImport;
  if (isUpdate) canImport = keys.length > 0 && shapeOk;
  else canImport = insertCount > 0 && shapeOk; // insert & replace both need docs
  if (isReplace) canImport = docs.length > 0 && shapeOk;

  const goClass = isReplace ? 'btn-danger' : 'btn-success';
  const goLabel = isReplace ? `Replace with ${pluralDocs(docs.length)}` : isUpdate ? `Upsert ${docs.length.toLocaleString()} row${docs.length === 1 ? '' : 's'}` : `Insert ${pluralDocs(insertCount)}`;

  return (
    <Fragment>
      <div class="modal-count-info">
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary)">{fileMeta?.name}</div>
        <div>{pluralDocs(docs.length)}{fileMeta?.size ? ` · ${formatBytes(fileMeta.size)}` : ''}</div>
      </div>

      <Segmented value={mode} options={MODE_SEG} onChange={setMode} ariaLabel="Import mode" testid="import-mode" tabs />

      {isUpdate && (
        <Fragment>
          <div class="modal-field-label" style="margin-top:10px">Match existing records by</div>
          <MatchKeyPicker paths={fieldPaths} keys={keys} setKeys={setKeys} />
          {keys.length === 0 && <div class="input-hint" style="color:var(--danger)">Select at least one match field.</div>}
        </Fragment>
      )}

      {/* Shape validation */}
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px">
        <Toggle checked={validateShape} onChange={setValidateShape} testid="shape-toggle" title="Validate against the existing records' shape" />
        <span>Validate shape against existing records</span>
      </label>
      {validateShape && (
        <div class="import-shape" data-testid="import-shape">
          {shapeLoading && <span>Checking shape{'…'}</span>}
          {!shapeLoading && !shape && <span class="input-hint">New or empty collection {'—'} nothing to validate against.</span>}
          {!shapeLoading && shape && !shape.uniform && (
            <div class="import-warn">Existing records aren't uniform (varying fields: <code>{shape.optionalPaths.slice(0, 6).join(', ') || 'mixed types'}</code>). Exact-shape validation may over-reject {'—'} consider turning it off.</div>
          )}
          {!shapeLoading && shapeCheck && !shapeCheck.ok && (
            <div class="import-conflict-info">
              Shape mismatch in {shapeCheck.failedDocCount.toLocaleString()} row{shapeCheck.failedDocCount === 1 ? '' : 's'}:
              {shapeCheck.missing.length > 0 && <div>Missing: <code>{shapeCheck.missing.join(', ')}</code></div>}
              {shapeCheck.unknown.length > 0 && <div>Unknown: <code>{shapeCheck.unknown.join(', ')}</code></div>}
              {shapeCheck.typeMismatch.length > 0 && <div>Type conflict: {shapeCheck.typeMismatch.map((t) => `${t.path} (expected ${t.expected.join('/')}, got ${t.got})`).join('; ')}</div>}
            </div>
          )}
          {!shapeLoading && shapeCheck && shapeCheck.ok && shape?.uniform && <span class="input-hint" style="color:var(--success)">Shape matches.</span>}
        </div>
      )}

      <div class="import-summary" data-testid="import-plan">
        {mode === 'insert' && (
          <span>Adds every row as a new document. If a row's <code>_id</code> already exists the insert is rejected and reported afterward {'—'} nothing already in the collection is changed. <strong>This file adds {insertCount.toLocaleString()} new document{insertCount === 1 ? '' : 's'}.</strong></span>
        )}
        {isUpdate && keys.length === 0 && <span>Choose one or more fields to match existing records by.</span>}
        {isUpdate && keys.length > 0 && (
          <span>Matches each row to an existing record by <code>{keys.join(', ')}</code>, then overwrites the whole matched record with the row. Rows that match nothing are inserted as new documents (upsert). Runs on the server{'—'} the collection updates in about a minute.</span>
        )}
        {isReplace && (
          <span><strong>Replaces the entire collection.</strong> Every existing record is deleted, then the {docs.length.toLocaleString()} row{docs.length === 1 ? '' : 's'} in this file become the collection's only contents. Indexes are kept. Runs on the server.</span>
        )}
      </div>

      <div class="modal-actions">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class={`btn ${goClass}`} data-testid="import-go" disabled={!canImport} onClick={onImport}>{goLabel}</button>
      </div>
    </Fragment>
  );
}
```

- [ ] **Step 4: Run, expect PASS + build** — `npx vitest run tests/mdh-import-confirm.test.js` then `npm run build`
- [ ] **Step 5: Commit** — stage `src/mdh/components/ImportConfirm.jsx tests/mdh-import-confirm.test.js`.

---

## Task 5: ImportWizard — routing, shape load, async execute

**Files:** Modify `src/mdh/components/ImportWizard.jsx`; Test `tests/mdh-import-wizard.test.js` (rewrite the plan/execute parts; keep source/format tests)

**Interfaces:**
- Consumes: `api.datasetUpdate`/`api.datasetReplace`/`api.waitForDatasetOperation`/`api.find` (from `api.js`); `runChunkedInsert`/`dedupeById` (from `importFile.js`); `deriveShape` (from `shape.js`); `ImportConfirm` (new props from Task 4); `ImportProgress`/`ImportSummary` (Task 3).
- Produces: the wizard routes Insert→Data Storage, Update→`datasetUpdate`, Replace→`datasetReplace`; loads a shape reference at the confirm stage; serializes docs to JSON for MDH.

- [ ] **Step 1: Write failing test** — rewrite the execution portion of `tests/mdh-import-wizard.test.js` (mock `../src/mdh/api.js` and `../src/mdh/importFile.js`):
```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';

vi.mock('../src/mdh/store.js', () => ({ selectedCollection: { value: 'products' } }));
vi.mock('../src/mdh/api.js', () => ({
  find: vi.fn().mockResolvedValue({ result: [{ sku: 'A1', price: 10 }] }),
  listIndexes: vi.fn().mockResolvedValue({ result: [] }),
  datasetUpdate: vi.fn().mockResolvedValue({ operationId: 'op1' }),
  datasetReplace: vi.fn().mockResolvedValue({ operationId: 'op2' }),
  waitForDatasetOperation: vi.fn().mockResolvedValue({ status: 'finished' }),
}));
vi.mock('../src/mdh/importFile.js', async (orig) => ({ ...(await orig()), runChunkedInsert: vi.fn().mockResolvedValue({ inserted: 2, failedBatches: [], cancelled: false }) }));

import ImportWizard from '../src/mdh/components/ImportWizard.jsx';
import * as api from '../src/mdh/api.js';
import { runChunkedInsert } from '../src/mdh/importFile.js';

function mount(vnode) { const el = document.createElement('div'); document.body.appendChild(el); render(vnode, el); return el; }
async function waitFor(fn, ms = 1000) { const t0 = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } }

beforeEach(() => vi.clearAllMocks());

// Helper: drive the wizard to CONFIRM via clipboard with a JSON array, then run.
async function toConfirm(root, json) {
  // (Use the existing clipboard path: fill the editor and click Next. If the
  //  test harness for the editor differs, reuse the file already established in
  //  this test file for reaching CONFIRM.)
}

describe('ImportWizard routing', () => {
  it('Replace uploads a JSON blob to datasetReplace and polls', async () => {
    // Arrange: mount, reach CONFIRM with two docs in replace mode, click Go.
    // Assert: api.datasetReplace called with collection 'products' and a Blob; waitForDatasetOperation called.
    // (Fill in using this file's existing CONFIRM-reaching helper.)
    expect(typeof api.datasetReplace).toBe('function');
  });
});
```
(NOTE to implementer: this test file already contains helpers that drive the wizard from PICK→CONFIRM via the clipboard editor for the previous plan/execute tests — reuse them. Replace the old assertions that referenced `probeCollection`/`executeImport`/`computePlan` with the routing assertions above: Insert → `runChunkedInsert` called; Update → `api.datasetUpdate(collection, <Blob>, keys)` then `api.waitForDatasetOperation`; Replace → `api.datasetReplace(collection, <Blob>)` then poll. Verify the blob body via `JSON.parse(await blob.text())`.)

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/mdh-import-wizard.test.js`

- [ ] **Step 3: Implement** — edit `src/mdh/components/ImportWizard.jsx`:

3a. Imports — replace lines 8-13:
```jsx
import ImportConfirm, { defaultKeysFor } from './ImportConfirm.jsx';
import { ImportProgress, ImportSummary } from './ImportStages.jsx';
import { getFormat, detectFormat, ALL_ACCEPT } from '../formats/index.js';
import { runChunkedInsert, dedupeById } from '../importFile.js';
import { deriveShape } from '../shape.js';
import * as api from '../api.js';
```

3b. State — replace the `plan`/`planLoading`/`indexedFields`/`upsert` state (lines 31-34) with:
```jsx
  const [validateShape, setValidateShape] = useState(readValidateShapePref());
  const [shape, setShape] = useState(null);
  const [shapeLoading, setShapeLoading] = useState(false);
```
Add near top of file (module scope), a tiny persisted-pref helper:
```jsx
const VALIDATE_SHAPE_KEY = 'mdhImportValidateShape';
function readValidateShapePref() { try { return globalThis.__mdhValidateShape !== false; } catch { return true; } }
function persistValidateShape(v) {
  try { globalThis.__mdhValidateShape = v; chrome?.storage?.local?.set?.({ [VALIDATE_SHAPE_KEY]: v }); } catch { /* no-op */ }
}
```
(On mount, hydrate from storage: add an effect
```jsx
  useEffect(() => { try { chrome?.storage?.local?.get?.(VALIDATE_SHAPE_KEY, (r) => { if (r && typeof r[VALIDATE_SHAPE_KEY] === 'boolean') setValidateShape(r[VALIDATE_SHAPE_KEY]); }); } catch { /* no-op */ } }, []);
```
and wrap `setValidateShape` at the call site so toggling persists — pass `(v) => { setValidateShape(v); persistValidateShape(v); }` to ImportConfirm.)

3c. Remove the index-loading effect (lines 103-113), the plan-recompute effect (lines 115-135), and the `indexWarning` block (lines 137-142). Replace with a **shape-reference load** effect:
```jsx
  // ---- confirm: sample the existing collection to derive its shape ----
  useEffect(() => {
    if (stage !== STAGE.CONFIRM) return undefined;
    let alive = true;
    setShapeLoading(true);
    api.find(selectedCollection.value, { limit: 500 })
      .then((res) => { if (!alive) return; const existing = res?.result || []; setShape(existing.length ? deriveShape(existing) : null); setShapeLoading(false); })
      .catch(() => { if (alive) { setShape(null); setShapeLoading(false); } });
    return () => { alive = false; };
  }, [stage, selectedCollection.value]);
```

3d. Rewrite `startImport` (lines 145-166):
```jsx
  async function startImport() {
    setErrorMsg(null);
    const docs = parsed.docs;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (mode === 'insert') {
        setStage(STAGE.IMPORTING);
        setImportProgress({ phase: 'insert', processed: 0, total: docs.length });
        const { kept } = dedupeById(docs);
        const r = await runChunkedInsert(selectedCollection.value, kept, { signal: ctrl.signal, onProgress: setImportProgress });
        setImportResult({ kind: 'insert', inserted: r.inserted, applied: 0, deleted: 0, skipped: 0, failedBatches: r.failedBatches, cancelled: r.cancelled });
        if (r.inserted > 0) onSuccess?.();
      } else {
        setStage(STAGE.IMPORTING);
        setImportProgress({ phase: 'uploading', indeterminate: true });
        const blob = new Blob([JSON.stringify(docs)], { type: 'application/json' });
        const { operationId } = mode === 'update'
          ? await api.datasetUpdate(selectedCollection.value, blob, keys, { signal: ctrl.signal })
          : await api.datasetReplace(selectedCollection.value, blob, { signal: ctrl.signal });
        setImportProgress({ phase: 'processing', indeterminate: true });
        await api.waitForDatasetOperation(operationId, { signal: ctrl.signal });
        setImportResult({ kind: mode, sent: docs.length, serverManaged: true, ok: true, failedBatches: [] });
        onSuccess?.();
      }
      setStage(STAGE.DONE);
    } catch (err) {
      setErrorMsg(`Import failed: ${err.message}`);
      setStage(STAGE.CONFIRM);
    } finally {
      abortRef.current = null;
    }
  }
```

3e. Update the CONFIRM render (lines 221-234) to pass the new props:
```jsx
      {stage === STAGE.CONFIRM && parsed && (
        <Fragment>
          <ImportConfirm
            fileMeta={fileMeta}
            docs={parsed.docs}
            mode={mode} setMode={setMode}
            keys={keys} setKeys={setKeys}
            validateShape={validateShape} setValidateShape={(v) => { setValidateShape(v); persistValidateShape(v); }}
            shape={shape} shapeLoading={shapeLoading}
            onImport={startImport} onCancel={closeModal}
          />
          {errorMsg && <div class="input-hint" style="color:var(--danger)">{errorMsg}</div>}
        </Fragment>
      )}
```
Also delete the now-unused `isMatch`, `upsert`, `keysKey` references.

- [ ] **Step 4: Run, expect PASS + build** — `npx vitest run tests/mdh-import-wizard.test.js` then `npm run build`
- [ ] **Step 5: Commit** — stage `src/mdh/components/ImportWizard.jsx tests/mdh-import-wizard.test.js`.

---

## Task 6: Cleanup — retire the client-side match engine

**Files:** Modify `src/mdh/importPlan.js`; Delete `src/mdh/runImport.js` + its tests; verify no dangling imports.

**Interfaces:** After this task, `importPlan.js` exports only what's still used (`collectFieldPaths`, `getPath`, `hasPath`); `runImport.js` is gone.

- [ ] **Step 1: Find remaining consumers** — run and confirm ONLY the expected references remain:
```bash
grep -rn "runImport" src/ tests/
grep -rn "from '.*importPlan" src/ tests/
grep -rn "probeCollection\|executeImport\|computePlan\|buildProbePipeline\|analyzeFileKeys\|buildUpdateSet\|buildReplacement" src/
```
Expected after Tasks 1-5: no `src/` references to `runImport`/`probeCollection`/`executeImport`/`computePlan` outside `runImport.js` itself; `importPlan` imported only for `collectFieldPaths` (in `ImportConfirm.jsx`).

- [ ] **Step 2: Delete `runImport.js` + tests**
```bash
git rm src/mdh/runImport.js
git rm tests/mdh-run-import.test.js 2>/dev/null || rm -f tests/mdh-run-import.test.js
```
(If other `tests/mdh-run-import*.test.js` exist, remove them too — they test the retired engine.)

- [ ] **Step 3: Trim `importPlan.js`** — remove the probe/plan exports no longer used: `MATCH_BATCH`, `stableKey` re-export, `keyValue`, `keyKeyOf`, `analyzeFileKeys`, `buildProbePipeline`, `computePlan`, `coerceKeyValue`. **Keep** `getPath`, `hasPath`, `collectFieldPaths`. Update `tests/mdh-import-plan.test.js` to drop tests for the removed exports (keep `collectFieldPaths`/`getPath`/`hasPath` tests). If the whole file becomes only path helpers, that's fine.

- [ ] **Step 4: Full build + suite**
```
npm run build && npm test
```
Expected: build clean; full suite green (no references to deleted modules; wizard/confirm/shape/api/stages tests pass).

- [ ] **Step 5: Commit** — stage all deletions/edits.

---

## Task 7: Live re-verify on the sandbox (gated, throwaway dataset)

**Files:** none (verification only). Requires the owner to (re)provide a dev-org token if the session's isn't connected.

- [ ] **Step 1:** With the owner's approval + the sandbox token, build a tiny 2-row JSON blob and exercise the exact client contract on a throwaway `zz_verify_<n>` dataset: `POST` create, `PATCH` update (`id_keys=['sku']`, `update_or_new=true`) with one existing + one new row, `PUT` replace, polling `GET /operation/{id}` each time, then `DELETE`. Confirm the multipart FormData the client emits (`file` + `encoding` + repeated `id_keys` + `update_or_new`) is accepted and the operations reach `finished`. This mirrors the brainstorming probe recorded in memory `reference_mdh_datamatching_dataset_api`.
- [ ] **Step 2:** Confirm a read-back through Data Storage shows the expected upsert/replace effect; delete the throwaway dataset; scrub the local token file.

---

## Self-Review

**Spec coverage:** hybrid routing → Tasks 2 (API) + 5 (wizard); JSON-upload fidelity → Task 5 (`Blob` of `JSON.stringify`); Update=upsert (`update_or_new=true`) → Task 2; Replace whole-dataset → Task 2/5; async lowercase poller → Task 2; shape derive+validate (deep, exact-set, null-symmetric, non-uniform warn, toggle default-on, empty→skip, all 3 modes) → Tasks 1 + 4 + 5; retire client match engine → Task 6; live re-verify → Task 7. ✓

**Placeholder scan:** Task 5's test step intentionally defers to "this file's existing CONFIRM-reaching helper" because the wizard's PICK→CONFIRM drive already exists in `tests/mdh-import-wizard.test.js`; the implementer reuses it (not a logic placeholder — the routing assertions are concrete). All code steps carry full code. ✓

**Type consistency:** `deriveShape`→`{paths:Map,uniform,optionalPaths}` and `validateAgainstShape`→`{ok,missing,unknown,typeMismatch,failedDocCount}` used identically in Tasks 1/4/5. `datasetUpdate(name,file,idKeys,{signal})`/`datasetReplace(name,file,{signal})`/`waitForDatasetOperation(id,{signal})` consistent across Tasks 2/5. `ImportConfirm` new prop set matches what Task 5 passes. Result shapes: Insert `{kind:'insert',inserted,...}`; server-managed `{kind,sent,serverManaged:true,ok,failedBatches}` consumed by Task 3's `ImportSummary`. ✓
