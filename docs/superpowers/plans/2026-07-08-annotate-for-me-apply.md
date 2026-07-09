# "Annotate for me" — Apply + Validate-Loop + Undo (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the read-only dry-run (Plan 1) into the real feature: one click auto-applies Fabry's corrections to the open annotation, validates against master data (MDH + Rules), loops to fix correctable errors until clean, and leaves a live changelog with one-click Undo — with rich progress so it never looks stuck.

**Architecture:** Reuses Plan 1's pipeline (gather → Fabry-with-vision → parse → resolve boxes → diff). Adds: same-origin write helpers (start → content/operations → cancel), a snapshot/undo layer (sessionStorage-persisted so Undo survives a manual reload), a validate-and-refine loop (reuses the SAME Fabry chat for corrections), full line-item targeting by **datapoint id**, and an `onProgress` stream that drives a richer panel. Fabry still routes through the background worker; all Rossum reads/writes are same-origin from the content script.

**Tech Stack:** esbuild (IIFE), vanilla DOM in content scripts (no Preact), vitest. No TypeScript.

## Global Constraints

- **No TypeScript.** Plain JS. Content-script UI is **vanilla DOM** — no Preact, no `innerHTML` (Trusted-Types-safe).
- **Tests:** `.test.js` in `tests/`; DOM tests use a first-line `// @vitest-environment jsdom` docblock (repo convention — do NOT set `environment` globally in `vitest.config.js`). Condition-based `waitFor`, never fixed `setTimeout`.
- **Writes are real but bounded.** The feature writes annotation **content** via `POST /annotations/{id}/content/operations` (wrapped start→ops→cancel). It MUST NEVER call confirm/export/approve/reject/delete, and MUST NEVER emit any operation other than `replace` on a **known datapoint id** from the current content tree.
- **Auto-apply with Undo.** Click → propose → write → loop → changelog + Undo (owner decision). Snapshot originals BEFORE the first write, persisted to `sessionStorage` keyed by annotation id, so Undo works even after a manual reload.
- **Loop is hard-capped.** ≤ `MAX_CORRECTIONS = 3` correction turns; stop on clean (no `error`-type messages), no-progress (error signature unchanged), or cap. Never loop on warnings.
- **Full line-item support via datapoint id.** Proposals target a specific datapoint id (each table row's cell has a distinct id); the prompt gives Fabry those ids + row indices. Writing to the wrong row is data corruption — an operation is emitted ONLY when its datapoint id exists in the current field set.
- **No customer data in logs/errors.** No field values in `console.*` or thrown/relayed messages.
- **Commits are owner-batched** — each task closes with `npm test` (+ `npm run build` where noted). Do NOT run `git commit`. Stay on master.
- **Browser dogfood needs a rebuild** (`npm run build`, reload extension, reload the Rossum tab).
- **Fabry facts (verified live):** vision via `{content, images:[{media_type,data}]}`; the SAME chat is reused for corrections by passing `chatId`. **`content/validate` response (verified live):** `{ messages: [{ type: 'error'|'warning'|'info', content, id /* datapoint id */, aggregation_type, schema_id }], updated_datapoints, suggested_operations, matched_trigger_rules }`. **`content/operations` (verified live):** `POST /annotations/{id}/content/operations` with `{operations:[{op:'replace', id:<datapointId>, value:{content:{value,position,page}}}]}` returns the full updated content tree; requires the annotation started; `start` → `{annotation, session_timeout}`, `cancel` → 204 (status → `to_review`); after a human edit `validation_sources` becomes `["human"]` and `position` holds the edit (`rir_position` stays original).

## Shared data shapes (contractual; extends Plan 1)

```
field    = { datapointId:number, schemaId:string, value:string|null,
             position:[n,n,n,n]|null, page:number|null, confidence:number|null,
             rowIndex:number|null,  // 1-based row within its multivalue, else null
             inLineItem:boolean }   // true if the datapoint sits inside a multivalue/tuple
proposal = { datapointId:number|null, schemaId:string, newValue:string|null,
             boxWords:string[]|null, boxPixels:[n,n,n,n]|null, page:number|null,
             reason:string, confidence:number|null }
change   = (Plan 1 change) & { rowIndex:number|null }   // datapointId is the write key
snapshot = { [datapointId:number]: { value:string|null, position:[n,n,n,n]|null, page:number|null } }
operation= { op:'replace', id:number, value:{ content:{ value:string|null, position?:[n,n,n,n], page?:number } } }
vmessage = { type:string, content:string, datapointId:number|null, schemaId:string|null }   // from content/validate
progress = onProgress(phase, detail)  // phase ∈ 'gather'|'propose'|'apply'|'validate'|'refine'|'done'|'error'
```

## File Structure

- Modify `src/rossum/api.js` — add `postRossumApi(path, body)` (same-origin POST → json, `.status` on error).
- Modify `src/rossum/annotate/gather.js` — `flattenFields` also emits `rowIndex` + `inLineItem`.
- Modify `src/rossum/annotate/prompt.js` — field lines include `datapoint_id` + row; OUTPUT_CONTRACT adds `datapoint_id`; add `buildFixPrompt`.
- Modify `src/rossum/annotate/proposal.js` — `parseProposal` reads `datapoint_id`; `diffProposals` matches by datapoint id (then schema id), carries `rowIndex`.
- Create `src/rossum/annotate/annotationWrite.js` — start / applyContentOperations / validateContent / parseValidateMessages / cancelAnnotation (I/O via injected `post`/`getJson`).
- Create `src/rossum/annotate/apply.js` — pure: `snapshotFields`, `buildReplaceOperations`, `buildRestoreOperations`.
- Create `src/rossum/annotate/undo.js` — sessionStorage snapshot persistence + `runUndo`.
- Create `src/rossum/annotate/propose.js` — shared read-only `proposeCorrections(...)`; `runDryRun` refactored to use it.
- Create `src/rossum/annotate/loop.js` — `runAnnotate(...)` orchestrator (propose → snapshot → apply → validate → refine → release).
- Modify `src/rossum/annotate/panel.js` — `setActivity`, `showResult({applied,remaining})`, Undo + Reload buttons.
- Modify `src/rossum/features/annotate-for-me.js` — `run()` calls `runAnnotate`, wires progress/Undo/Reload + snapshot persistence.
- Tests: one `tests/annotate-*.test.js` per module (+ extend existing proposal/prompt/gather/panel/api tests).

**Milestone:** after Task 8 the feature auto-applies once + undoes (no loop yet — a working increment); Tasks 9–11 add the validate-loop + rich progress.

---

### Task 1: `postRossumApi` (same-origin POST)

**Files:** Modify `src/rossum/api.js`; Test `tests/annotate-api.test.js` (extend).

**Interfaces:** Produces `postRossumApi(path, body) → Promise<object>` — same-origin POST via `safeApiUrl`, `Authorization: Token`, `Content-Type: application/json`, `body` JSON-stringified; returns parsed JSON (or `{}` for 204); throws `apiError(status)` on non-ok.

- [ ] **Step 1: Failing test** (append to `tests/annotate-api.test.js`)

```js
import { postRossumApi } from '../src/rossum/api.js';

describe('postRossumApi', () => {
  it('POSTs json to a same-origin path with the token', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) });
    const out = await postRossumApi('/api/v1/annotations/5/content/operations', { operations: [] });
    expect(out).toEqual({ ok: 1 });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://x.rossum.app/api/v1/annotations/5/content/operations');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Token TKN');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ operations: [] });
  });
  it('returns {} for a 204 (no body)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) });
    expect(await postRossumApi('/api/v1/annotations/5/cancel', {})).toEqual({});
  });
  it('throws apiError with .status on non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    const e = await postRossumApi('/api/v1/annotations/5/start', {}).catch((x) => x);
    expect(e.status).toBe(409);
  });
  it('rejects a non-/api/v1 path', async () => {
    await expect(postRossumApi('/evil', {})).rejects.toThrow(/Invalid API path/);
  });
});
```
(The `beforeEach` already sets `global.window` with `location.origin` `https://x.rossum.app` and `localStorage.getItem → 'TKN'`.)

- [ ] **Step 2: Run → FAIL** `npx vitest run tests/annotate-api.test.js` (postRossumApi not exported).

- [ ] **Step 3: Implement** (append to `src/rossum/api.js`, reuse `safeApiUrl`/`authHeaders`/`apiError`)

```js
// Same-origin POST → parsed JSON ({} for 204). Used for annotation writes/validate.
export function postRossumApi(path, body) {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  return fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => {
    if (!r.ok) throw apiError(r.status);
    if (r.status === 204) return {};
    return r.json().catch(() => ({}));
  });
}
```

- [ ] **Step 4: Run → PASS.** `npx vitest run tests/annotate-api.test.js`
- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 2: `flattenFields` line-item context (rowIndex + inLineItem)

**Files:** Modify `src/rossum/annotate/gather.js`; Test `tests/annotate-gather.test.js` (extend).

**Interfaces:** `flattenFields(nodes)` now also returns `rowIndex` (1-based position of the datapoint's ancestor `tuple` within its `multivalue`, else `null`) and `inLineItem` (true when the datapoint is inside a multivalue/tuple). Header datapoints: `rowIndex:null, inLineItem:false`. `gatherAnnotation` output unchanged in shape (fields just carry the two extra keys).

- [ ] **Step 1: Failing test** (append)

```js
import { flattenFields } from '../src/rossum/annotate/gather.js';

describe('flattenFields line-item context', () => {
  const tree = [{ category: 'section', children: [
    { category: 'datapoint', id: 1, schema_id: 'total', content: { value: 'x', position: [0,0,1,1], page: 1, rir_confidence: 0.9 } },
    { category: 'multivalue', children: [
      { category: 'tuple', children: [{ category: 'datapoint', id: 10, schema_id: 'item_amount', content: { value: 'a' } }] },
      { category: 'tuple', children: [{ category: 'datapoint', id: 11, schema_id: 'item_amount', content: { value: 'b' } }] },
    ] },
  ] }];
  it('marks header fields inLineItem:false rowIndex:null and tuple cells with 1-based rowIndex', () => {
    const f = flattenFields(tree);
    expect(f.find((x) => x.datapointId === 1)).toMatchObject({ inLineItem: false, rowIndex: null });
    expect(f.find((x) => x.datapointId === 10)).toMatchObject({ schemaId: 'item_amount', inLineItem: true, rowIndex: 1 });
    expect(f.find((x) => x.datapointId === 11)).toMatchObject({ schemaId: 'item_amount', inLineItem: true, rowIndex: 2 });
  });
});
```

- [ ] **Step 2: Run → FAIL** (fields lack rowIndex/inLineItem).

- [ ] **Step 3: Implement** — replace `flattenFields` in `gather.js` with a walker that threads row context:

```js
export function flattenFields(nodes) {
  const out = [];
  const walk = (list, ctx) => {
    for (const n of list || []) {
      if (n.category === 'datapoint') {
        const c = n.content || {};
        out.push({
          datapointId: n.id,
          schemaId: n.schema_id,
          value: c.value ?? null,
          position: Array.isArray(c.position) ? c.position : null,
          page: c.page ?? null,
          confidence: c.rir_confidence ?? null,
          rowIndex: ctx.rowIndex,
          inLineItem: ctx.inLineItem,
        });
      } else if (n.category === 'multivalue' && Array.isArray(n.children)) {
        n.children.forEach((tuple, i) => {
          if (tuple && tuple.category === 'tuple') walk(tuple.children, { inLineItem: true, rowIndex: i + 1 });
          else walk([tuple], { inLineItem: true, rowIndex: i + 1 });
        });
      } else if (Array.isArray(n.children)) {
        walk(n.children, ctx);
      }
    }
  };
  walk(nodes, { inLineItem: false, rowIndex: null });
  return out;
}
```
(The existing `gatherAnnotation` and other exports stay unchanged.)

- [ ] **Step 4: Run → PASS.** Also confirm the pre-existing flattenFields tests still pass (header-only trees → `inLineItem:false, rowIndex:null`; update those expectations if they assert exact objects).
- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 3: `proposal.js` — datapoint-id targeting

**Files:** Modify `src/rossum/annotate/proposal.js`; Test `tests/annotate-proposal.test.js` (extend).

**Interfaces:** `parseProposal` reads optional `o.datapoint_id` → `datapointId:number|null`. `diffProposals(resolved, fields)` matches a proposal to a field by **datapoint id first** (exact — required for line-item rows), then falls back to `schemaId` (first matching field) ONLY when `datapointId` is null; a proposal whose `datapointId` matches no field is **skipped** (never silently rewritten to another row). Emitted `change` carries `rowIndex` (from the matched field).

- [ ] **Step 1: Failing tests** (append)

```js
describe('parseProposal datapoint_id', () => {
  it('reads datapoint_id when present, null otherwise', () => {
    expect(parseProposal('[{"schema_id":"item_amount","datapoint_id":11,"new_value":"9"}]')[0].datapointId).toBe(11);
    expect(parseProposal('[{"schema_id":"total","new_value":"9"}]')[0].datapointId).toBeNull();
  });
});
describe('diffProposals datapoint-id targeting', () => {
  const fields = [
    { datapointId: 10, schemaId: 'item_amount', value: 'a', position: null, page: 1, rowIndex: 1, inLineItem: true },
    { datapointId: 11, schemaId: 'item_amount', value: 'b', position: null, page: 1, rowIndex: 2, inLineItem: true },
    { datapointId: 1, schemaId: 'total', value: 'x', position: null, page: 1, rowIndex: null, inLineItem: false },
  ];
  it('targets the exact row by datapoint id', () => {
    const r = [{ datapointId: 11, schemaId: 'item_amount', newValue: 'B2', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    const out = diffProposals(r, fields);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ datapointId: 11, rowIndex: 2, oldValue: 'b', newValue: 'B2' });
  });
  it('falls back to schema_id (first field) only when datapointId is null', () => {
    const r = [{ datapointId: null, schemaId: 'total', newValue: 'X2', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(r, fields)[0]).toMatchObject({ datapointId: 1, newValue: 'X2' });
  });
  it('skips a proposal whose datapoint id matches no field', () => {
    const r = [{ datapointId: 999, schemaId: 'item_amount', newValue: 'z', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(r, fields)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — in `parseProposal`'s `.map`, add `datapointId: typeof o.datapoint_id === 'number' ? o.datapoint_id : null,`. Replace the field lookup + push in `diffProposals`:

```js
export function diffProposals(resolved, fields) {
  const out = [];
  for (const p of resolved) {
    const f = p.datapointId != null
      ? fields.find((x) => x.datapointId === p.datapointId)
      : fields.find((x) => x.schemaId === p.schemaId);
    if (!f) continue; // unknown datapoint id (or schema) → skip, never write to the wrong field/row
    const newValue = p.newValue;
    const newBox = p.resolvedBox;
    const valueChanged = newValue != null && String(newValue) !== String(f.value ?? '');
    const boxChanged = !!newBox && !sameBox(newBox, f.position);
    if (!valueChanged && !boxChanged) continue;
    out.push({
      schemaId: f.schemaId, datapointId: f.datapointId, rowIndex: f.rowIndex ?? null,
      oldValue: f.value ?? null, newValue: valueChanged ? newValue : (f.value ?? null),
      oldBox: f.position, newBox: boxChanged ? newBox : f.position,
      page: p.page ?? f.page, boxSource: p.boxSource,
      reason: p.reason, confidence: p.confidence,
      valueChanged, boxChanged,
    });
  }
  return out;
}
```
(Note: `schemaId`/`rowIndex` now come from the matched field `f`, not the proposal.)

- [ ] **Step 4: Run → PASS** (all prior proposal tests still green — header-only fixtures have `datapointId:null` proposals → schema fallback preserves old behavior; if a prior fixture field lacks `rowIndex`, `f.rowIndex ?? null` yields null).
- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 4: `prompt.js` — datapoint ids, row context, fix prompt

**Files:** Modify `src/rossum/annotate/prompt.js`; Test `tests/annotate-prompt.test.js` (extend).

**Interfaces:** `buildAnnotatePrompt` field lines now include `dp#<datapointId>` and, for line-item fields, `row <rowIndex>`; OUTPUT_CONTRACT instructs Fabry to return `datapoint_id` (preferred for line items). New export `buildFixPrompt({ errors, fields, schemaFields, maxChars? }) → string` — a lean correction prompt listing the remaining validation errors (each with its `dp#` + schema + message) and the CURRENT values of the referenced datapoints, instructing the same JSON contract keyed by `datapoint_id`.

- [ ] **Step 1: Failing tests** (append)

```js
import { buildFixPrompt } from '../src/rossum/annotate/prompt.js';

describe('buildAnnotatePrompt datapoint ids', () => {
  it('includes dp# and row for line-item fields and datapoint_id in the contract', () => {
    const p = buildAnnotatePrompt({
      fields: [{ datapointId: 11, schemaId: 'item_amount', value: 'b', position: null, page: 1, confidence: 0.4, rowIndex: 2, inLineItem: true }],
      messages: [], ocrPages: [], schemaFields: [{ schemaId: 'item_amount', label: 'Amount', type: 'number', required: false }],
    });
    expect(p).toContain('dp#11');
    expect(p).toContain('row 2');
    expect(p).toMatch(/datapoint_id/);
  });
});
describe('buildFixPrompt', () => {
  it('lists remaining errors with dp# and asks for datapoint_id-keyed json', () => {
    const p = buildFixPrompt({
      errors: [{ type: 'error', content: 'not in master data', datapointId: 11, schemaId: 'item_amount' }],
      fields: [{ datapointId: 11, schemaId: 'item_amount', value: 'b', position: null, page: 1, confidence: 0.4, rowIndex: 2, inLineItem: true }],
      schemaFields: [],
    });
    expect(p).toContain('dp#11');
    expect(p).toContain('not in master data');
    expect(p).toMatch(/datapoint_id/);
    expect(p).toMatch(/json/i);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**
  - In `OUTPUT_CONTRACT`, change the element shape line to include the id key, e.g. add after the `{ "schema_id"...` line: `'  "datapoint_id": number,  // REQUIRED for line-item (table) cells; identifies the exact row',`.
  - Replace `fieldsBlock`'s return with a datapoint-id + row aware line:
    ```js
    const row = f.inLineItem && f.rowIndex != null ? ` row ${f.rowIndex}` : '';
    return `- dp#${f.datapointId} ${f.schemaId} ("${s.label || f.schemaId}"${req}, ${s.type || '?'}${row}) `
      + `value=${JSON.stringify(f.value)} box=${JSON.stringify(f.position)} page=${f.page} confidence=${f.confidence}`;
    ```
  - Add `buildFixPrompt`:
    ```js
    export function buildFixPrompt({ errors, fields, schemaFields, maxChars = 40000 }) {
      const byId = Object.fromEntries((fields || []).map((f) => [f.datapointId, f]));
      const errLines = (errors || []).map((e) => {
        const f = e.datapointId != null ? byId[e.datapointId] : null;
        const cur = f ? ` (current value=${JSON.stringify(f.value)}${f.inLineItem && f.rowIndex != null ? `, row ${f.rowIndex}` : ''})` : '';
        return `- [${e.type}] dp#${e.datapointId ?? '?'} ${e.schemaId || ''}: ${e.content}${cur}`;
      }).join('\n');
      const out = [
        'Some corrections still fail validation against master data / rules. Fix ONLY these.',
        'Return ONLY a fenced ```json array; each element { "datapoint_id": number, "new_value": string, "reason": string, "confidence": number }.',
        'Use the datapoint_id from each error to target the exact field/row. Do NOT call tools.',
        '', '## Remaining validation errors', errLines || '(none)',
      ].join('\n');
      return out.length > maxChars ? out.slice(0, maxChars) : out;
    }
    ```

- [ ] **Step 4: Run → PASS** (the char-budget + head-protection tests from Plan 1 still pass — head grew slightly but the branches are unchanged).
- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 5: `annotationWrite.js` — write/validate primitives

**Files:** Create `src/rossum/annotate/annotationWrite.js`; Test `tests/annotate-annotationwrite.test.js`.

**Interfaces (all take injected I/O so tests use fakes):**
- `startAnnotation(annotationId, { post }) → Promise` (`POST /annotations/{id}/start`).
- `applyContentOperations(annotationId, operations, { post }) → Promise<content>` (`POST …/content/operations`, returns the response's `content` array).
- `validateContent(annotationId, { post }) → Promise<validateResponse>` (`POST …/content/validate`, body `{}`).
- `parseValidateMessages(validateResponse) → vmessage[]` (pure): map `messages` to `{type, content, datapointId: m.id ?? null, schemaId: m.schema_id ?? null}`.
- `cancelAnnotation(annotationId, { post }) → Promise` (`POST …/cancel`).

- [ ] **Step 1: Failing test**

```js
import { startAnnotation, applyContentOperations, validateContent, parseValidateMessages, cancelAnnotation } from '../src/rossum/annotate/annotationWrite.js';
import { describe, it, expect, vi } from 'vitest';

describe('annotationWrite', () => {
  it('start/apply/validate/cancel hit the right paths', async () => {
    const post = vi.fn((p) => {
      if (p.endsWith('/start')) return Promise.resolve({ annotation: 'u' });
      if (p.endsWith('/content/operations')) return Promise.resolve({ content: [{ id: 1 }] });
      if (p.endsWith('/content/validate')) return Promise.resolve({ messages: [] });
      if (p.endsWith('/cancel')) return Promise.resolve({});
      throw new Error('x ' + p);
    });
    await startAnnotation(5, { post });
    expect(post).toHaveBeenCalledWith('/api/v1/annotations/5/start', {});
    const content = await applyContentOperations(5, [{ op: 'replace', id: 1, value: { content: { value: 'z' } } }], { post });
    expect(content).toEqual([{ id: 1 }]);
    expect(post.mock.calls.find((c) => c[0].endsWith('/content/operations'))[1]).toEqual({ operations: [{ op: 'replace', id: 1, value: { content: { value: 'z' } } }] });
    await validateContent(5, { post });
    await cancelAnnotation(5, { post });
    expect(post).toHaveBeenCalledWith('/api/v1/annotations/5/cancel', {});
  });
  it('parseValidateMessages maps id→datapointId and schema_id', () => {
    expect(parseValidateMessages({ messages: [{ type: 'error', content: 'bad', id: 11, schema_id: 'item_amount' }] }))
      .toEqual([{ type: 'error', content: 'bad', datapointId: 11, schemaId: 'item_amount' }]);
    expect(parseValidateMessages({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Implement**

```js
// src/rossum/annotate/annotationWrite.js
// Same-origin annotation write/validate primitives. I/O via injected `post`
// (postRossumApi) so the loop is unit-testable. Writes content ONLY.
export function startAnnotation(id, { post }) { return post(`/api/v1/annotations/${id}/start`, {}); }
export function applyContentOperations(id, operations, { post }) {
  return post(`/api/v1/annotations/${id}/content/operations`, { operations }).then((r) => (r && r.content) || []);
}
export function validateContent(id, { post }) { return post(`/api/v1/annotations/${id}/content/validate`, {}); }
export function cancelAnnotation(id, { post }) { return post(`/api/v1/annotations/${id}/cancel`, {}); }
export function parseValidateMessages(res) {
  return ((res && res.messages) || []).map((m) => ({
    type: m.type, content: m.content, datapointId: m.id ?? null, schemaId: m.schema_id ?? null,
  }));
}
```

- [ ] **Step 4: Run → PASS.**  - [ ] **Step 5: Gate** — `npm test` green.

---

### Task 6: `apply.js` — snapshot + operation builders (pure)

**Files:** Create `src/rossum/annotate/apply.js`; Test `tests/annotate-apply.test.js`.

**Interfaces (pure):**
- `snapshotFields(fields, datapointIds) → snapshot` — original `{value,position,page}` for each id in `datapointIds` (found in `fields`).
- `buildReplaceOperations(changes) → operation[]` — one `replace` per change; `content.value = change.newValue`; include `position`+`page` ONLY when `change.newBox` is non-null.
- `buildRestoreOperations(snapshot) → operation[]` — one `replace` per snapshot entry restoring original value; include `position`+`page` only when the original `position` is non-null.

- [ ] **Step 1: Failing test**

```js
import { snapshotFields, buildReplaceOperations, buildRestoreOperations } from '../src/rossum/annotate/apply.js';
import { describe, it, expect } from 'vitest';

const fields = [
  { datapointId: 1, value: 'x', position: [0,0,1,1], page: 1 },
  { datapointId: 2, value: 'y', position: null, page: 2 },
];
describe('apply', () => {
  it('snapshots originals for the given ids', () => {
    expect(snapshotFields(fields, [1, 2])).toEqual({
      1: { value: 'x', position: [0,0,1,1], page: 1 },
      2: { value: 'y', position: null, page: 2 },
    });
  });
  it('builds replace ops; position/page only when newBox present', () => {
    const changes = [
      { datapointId: 1, newValue: 'X', newBox: [2,2,3,3], page: 1, valueChanged: true, boxChanged: true },
      { datapointId: 2, newValue: 'Y', newBox: null, page: 2, valueChanged: true, boxChanged: false },
    ];
    expect(buildReplaceOperations(changes)).toEqual([
      { op: 'replace', id: 1, value: { content: { value: 'X', position: [2,2,3,3], page: 1 } } },
      { op: 'replace', id: 2, value: { content: { value: 'Y' } } },
    ]);
  });
  it('builds restore ops from a snapshot', () => {
    expect(buildRestoreOperations({ 1: { value: 'x', position: [0,0,1,1], page: 1 }, 2: { value: 'y', position: null, page: 2 } })).toEqual([
      { op: 'replace', id: 1, value: { content: { value: 'x', position: [0,0,1,1], page: 1 } } },
      { op: 'replace', id: 2, value: { content: { value: 'y' } } },
    ]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```js
// src/rossum/annotate/apply.js — pure: snapshot + content-operation builders.
export function snapshotFields(fields, datapointIds) {
  const snap = {};
  for (const id of datapointIds) {
    const f = fields.find((x) => x.datapointId === id);
    if (f) snap[id] = { value: f.value ?? null, position: f.position ?? null, page: f.page ?? null };
  }
  return snap;
}
function contentOf(value, box, page) {
  const content = { value: value ?? null };
  if (box) { content.position = box; content.page = page; }
  return { content };
}
export function buildReplaceOperations(changes) {
  return changes.map((c) => ({ op: 'replace', id: c.datapointId, value: contentOf(c.newValue, c.newBox, c.page) }));
}
export function buildRestoreOperations(snapshot) {
  return Object.keys(snapshot).map((id) => {
    const s = snapshot[id];
    return { op: 'replace', id: Number(id), value: contentOf(s.value, s.position, s.page) };
  });
}
```

- [ ] **Step 4: Run → PASS.**  - [ ] **Step 5: Gate** — `npm test` green.

---

### Task 7: `undo.js` — snapshot persistence + runUndo

**Files:** Create `src/rossum/annotate/undo.js`; Test `tests/annotate-undo.test.js`.

**Interfaces:**
- `snapKey(annotationId) → string` = `rossum-sa-extension-annotate-snap-<id>`.
- `saveSnapshot(annotationId, snapshot, store = sessionStorage)` / `loadSnapshot(annotationId, store = sessionStorage) → snapshot|null` / `clearSnapshot(annotationId, store = sessionStorage)` — sessionStorage-backed, try/catch-safe.
- `runUndo({ annotationId, deps, onProgress }) → Promise<{restored:number}>` where `deps = { post, loadSnapshot?, clearSnapshot? }` — loads the snapshot; if none, returns `{restored:0}`; else `startAnnotation → applyContentOperations(buildRestoreOperations(snapshot)) → cancelAnnotation`, clears the snapshot, returns count. `onProgress('undo', …)` ticks.

- [ ] **Step 1: Failing test**

```js
import { snapKey, saveSnapshot, loadSnapshot, clearSnapshot, runUndo } from '../src/rossum/annotate/undo.js';
import { describe, it, expect, vi } from 'vitest';

function memStore() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } }; }

describe('undo persistence', () => {
  it('save/load/clear round-trips', () => {
    const s = memStore();
    saveSnapshot(5, { 1: { value: 'x', position: null, page: 1 } }, s);
    expect(loadSnapshot(5, s)).toEqual({ 1: { value: 'x', position: null, page: 1 } });
    clearSnapshot(5, s);
    expect(loadSnapshot(5, s)).toBeNull();
  });
});
describe('runUndo', () => {
  it('restores from snapshot via start→ops→cancel and clears it', async () => {
    const s = memStore();
    saveSnapshot(5, { 1: { value: 'x', position: [0,0,1,1], page: 1 } }, s);
    const post = vi.fn(() => Promise.resolve({ content: [] }));
    const out = await runUndo({ annotationId: 5, deps: { post, store: s }, onProgress: () => {} });
    expect(out.restored).toBe(1);
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/annotations/5/start', '/api/v1/annotations/5/content/operations', '/api/v1/annotations/5/cancel',
    ]);
    expect(loadSnapshot(5, s)).toBeNull();
  });
  it('no-ops when there is no snapshot', async () => {
    const post = vi.fn();
    expect(await runUndo({ annotationId: 9, deps: { post, store: memStore() }, onProgress: () => {} })).toEqual({ restored: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```js
// src/rossum/annotate/undo.js — sessionStorage snapshot + revert (start→restore ops→cancel).
import { startAnnotation, applyContentOperations, cancelAnnotation } from './annotationWrite.js';
import { buildRestoreOperations } from './apply.js';

export function snapKey(id) { return `rossum-sa-extension-annotate-snap-${id}`; }
export function saveSnapshot(id, snapshot, store = sessionStorage) {
  try { store.setItem(snapKey(id), JSON.stringify(snapshot)); } catch { /* ignore */ }
}
export function loadSnapshot(id, store = sessionStorage) {
  try { const s = store.getItem(snapKey(id)); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function clearSnapshot(id, store = sessionStorage) {
  try { store.removeItem(snapKey(id)); } catch { /* ignore */ }
}
export async function runUndo({ annotationId, deps, onProgress = () => {} }) {
  const store = deps.store || sessionStorage;
  const snapshot = loadSnapshot(annotationId, store);
  if (!snapshot || !Object.keys(snapshot).length) return { restored: 0 };
  onProgress('undo', 'Reverting changes…');
  await startAnnotation(annotationId, deps);
  try {
    await applyContentOperations(annotationId, buildRestoreOperations(snapshot), deps);
  } finally {
    await cancelAnnotation(annotationId, deps);
  }
  clearSnapshot(annotationId, store);
  return { restored: Object.keys(snapshot).length };
}
```

- [ ] **Step 4: Run → PASS.**  - [ ] **Step 5: Gate** — `npm test` green.

---

### Task 8: `propose.js` — shared read-only propose; refactor dryRun

**Files:** Create `src/rossum/annotate/propose.js`; Modify `src/rossum/annotate/dryRun.js`; Test `tests/annotate-propose.test.js` (+ keep `tests/annotate-dryrun.test.js` green).

**Interfaces:** `proposeCorrections({ annotationId, token, domain, deps, onEvent }) → Promise<{ changes, chatId, reply, reasoning, gathered }>` where `deps = { getJson, getBase64, streamFabry }`, `gathered` is the `gatherAnnotation` result, `onEvent` (optional) is invoked per Fabry event (in ADDITION to internal folding). `runDryRun` becomes a thin wrapper returning `{ changes, reply, reasoning }`.

- [ ] **Step 1: Failing test** (`tests/annotate-propose.test.js`)

```js
import { proposeCorrections } from '../src/rossum/annotate/propose.js';
import { describe, it, expect, vi } from 'vitest';

it('proposeCorrections returns changes + chatId + gathered', async () => {
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: [
      { category: 'datapoint', id: 1, schema_id: 'd', content: { value: 'old', position: [10,10,30,20], page: 1, rir_confidence: 0.4 } },
    ] });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [10,10,50,20], text: 'INV-1' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 100, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  const streamFabry = vi.fn(async ({ onEvent }) => {
    onEvent({ type: 'text-delta', delta: '```json\n[{"schema_id":"d","datapoint_id":1,"new_value":"INV-1","box_words":["INV-1"],"page":1,"reason":"fix","confidence":0.9}]\n```' });
    onEvent({ type: '__done__' });
    return { chatId: 'c1' };
  });
  const out = await proposeCorrections({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry } });
  expect(out.chatId).toBe('c1');
  expect(out.changes[0]).toMatchObject({ datapointId: 1, newValue: 'INV-1', boxChanged: true });
  expect(out.gathered.fields).toHaveLength(1);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `propose.js`, then refactor `dryRun.js`:

```js
// src/rossum/annotate/propose.js — shared read-only proposal step (no writes).
import { gatherAnnotation } from './gather.js';
import { buildAnnotatePrompt } from './prompt.js';
import { parseProposal, resolveBoxes, diffProposals } from './proposal.js';
import { newAcc, foldEvents, replyText } from '../../mdh/agent/agentStream.js';

export async function proposeCorrections({ annotationId, token, domain, deps, onEvent }) {
  const { getJson, getBase64, streamFabry } = deps;
  const gathered = await gatherAnnotation(annotationId, { getJson, getBase64 });
  const content = buildAnnotatePrompt({
    fields: gathered.fields, messages: gathered.messages, ocrPages: gathered.ocrPages, schemaFields: gathered.schemaFields,
  });
  const images = gathered.pageImages.map((p) => ({ media_type: p.mediaType, data: p.data }));
  const acc = newAcc();
  const { chatId } = await streamFabry({ token, domain, content, images, onEvent: (ev) => { foldEvents(acc, [ev]); if (onEvent) onEvent(ev); } });
  const reply = replyText(acc);
  const changes = diffProposals(resolveBoxes(parseProposal(reply), gathered.ocrPages), gathered.fields);
  return { changes, chatId, reply, reasoning: acc.reasoning, gathered };
}
```

```js
// src/rossum/annotate/dryRun.js — now a thin wrapper (read-only).
import { proposeCorrections } from './propose.js';
export async function runDryRun({ annotationId, token, domain, deps }) {
  const { changes, reply, reasoning } = await proposeCorrections({ annotationId, token, domain, deps });
  return { changes, reply, reasoning };
}
```
(NOTE: `streamFabry` must resolve to `{ chatId }` — Plan 1's `fabryBridge.streamFabry` already does; the Plan 1 dryRun test's fake must return `{ chatId }`. If `tests/annotate-dryrun.test.js`'s fake `streamFabry` doesn't return a chatId, update that fake to `return { chatId: 'c1' };` — behavior otherwise unchanged.)

- [ ] **Step 4: Run → PASS** (`tests/annotate-propose.test.js` + `tests/annotate-dryrun.test.js`).
- [ ] **Step 5: Gate** — `npm test` green.

**Milestone note:** Tasks 9–11 build the loop + UI on top; the pieces so far (write primitives, apply/undo, propose) are independently green.

---

### Task 9: `loop.js` — runAnnotate orchestrator

**Files:** Create `src/rossum/annotate/loop.js`; Test `tests/annotate-loop.test.js`.

**Interfaces:** `runAnnotate({ annotationId, token, domain, deps, onProgress }) → Promise<{ applied, remaining, undoable }>`, `deps = { getJson, getBase64, streamFabry, post, store? }`. Flow:
1. `onProgress('gather')` → `proposeCorrections` (passing an `onEvent` that maps Fabry events to `onProgress('propose', activity)` — reasoning-start → "analyzing", tool-input-start → `toolLabel`, text-delta → "drafting").
2. If no changes → `onProgress('done', …)`, return `{ applied: [], remaining: [], undoable: false }`.
3. Snapshot originals for the changed datapoint ids (`snapshotFields`), `saveSnapshot`.
4. `startAnnotation`. Then `onProgress('apply', 'Applying N corrections…')`; `applyContentOperations(buildReplaceOperations(changes))` → updated content → `flattenFields` → current fields; mark those changes applied.
5. `onProgress('validate')`; `validateContent` → `parseValidateMessages` → errors (`type==='error'`).
6. Refine loop up to `MAX_CORRECTIONS=3`, stop on no errors or unchanged error-signature: `onProgress('refine', 'Fixing M issue(s) — attempt K/3…')`; `buildFixPrompt(errors, currentFields)` → `streamFabry({ chatId, … })` (SAME chat) → `parseProposal`/`resolveBoxes`/`diffProposals(_, currentFields)`; if no new changes → break; extend snapshot with any NEW datapoint ids (from ORIGINAL fields captured in step 1's gather) + `saveSnapshot`; `applyContentOperations` → re-flatten; re-validate.
7. `finally` `cancelAnnotation`.
8. `onProgress('done', …)`; return `{ applied: <all applied changes>, remaining: <final error vmessages>, undoable: true }`.

Errors must not leave the annotation started: wrap steps 4–7 so `cancelAnnotation` always runs.

- [ ] **Step 1: Failing test** (drive the happy path + one refine turn with fakes)

```js
import { runAnnotate } from '../src/rossum/annotate/loop.js';
import { describe, it, expect, vi } from 'vitest';

function memStore() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } }; }

it('proposes → applies → validates → refines once → clean, and is undoable', async () => {
  const contentTree = [{ category: 'datapoint', id: 1, schema_id: 'd', content: { value: 'old', position: [10,10,30,20], page: 1, rir_confidence: 0.4 } }];
  const getJson = vi.fn((p) => {
    if (p.endsWith('/content')) return Promise.resolve({ content: contentTree });
    if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
    if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [10,10,50,20], text: 'INV-1' }] }] });
    if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 9, number: 1, width: 100, height: 100 }] });
    if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
    throw new Error('x ' + p);
  });
  const getBase64 = vi.fn(() => Promise.resolve('B64'));
  let turn = 0;
  const streamFabry = vi.fn(async ({ onEvent }) => {
    turn += 1;
    const json = turn === 1
      ? '[{"schema_id":"d","datapoint_id":1,"new_value":"INV-1","box_words":["INV-1"],"page":1,"reason":"fix","confidence":0.9}]'
      : '[{"datapoint_id":1,"new_value":"INV-2","reason":"still bad","confidence":0.9}]';
    onEvent({ type: 'text-delta', delta: '```json\n' + json + '\n```' });
    onEvent({ type: '__done__' });
    return { chatId: 'c1' };
  });
  // validate: first call after initial apply → 1 error on dp1; after the refine apply → clean.
  let validated = 0;
  const post = vi.fn((p, body) => {
    if (p.endsWith('/start') || p.endsWith('/cancel')) return Promise.resolve({});
    if (p.endsWith('/content/operations')) {
      const op = body.operations[0];
      contentTree[0].content.value = op.value.content.value; // reflect write
      return Promise.resolve({ content: contentTree });
    }
    if (p.endsWith('/content/validate')) { validated += 1; return Promise.resolve({ messages: validated === 1 ? [{ type: 'error', content: 'not in master data', id: 1, schema_id: 'd' }] : [] }); }
    throw new Error('x ' + p);
  });
  const store = memStore();
  const progress = [];
  const out = await runAnnotate({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry, post, store }, onProgress: (ph) => progress.push(ph) });
  expect(out.undoable).toBe(true);
  expect(out.applied.length).toBeGreaterThanOrEqual(1);
  expect(out.remaining).toEqual([]);
  expect(streamFabry).toHaveBeenCalledTimes(2); // initial + one refine
  expect(post.mock.calls.filter((c) => c[0].endsWith('/cancel'))).toHaveLength(1); // released exactly once
  expect(progress).toContain('apply');
  expect(progress).toContain('validate');
  // snapshot persisted for undo
  const { loadSnapshot } = await import('../src/rossum/annotate/undo.js');
  expect(loadSnapshot(5, store)).toMatchObject({ 1: { value: 'old' } });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```js
// src/rossum/annotate/loop.js — auto-apply + validate/refine loop (writes content).
import { proposeCorrections } from './propose.js';
import { flattenFields } from './gather.js';
import { buildFixPrompt } from './prompt.js';
import { parseProposal, resolveBoxes, diffProposals } from './proposal.js';
import { snapshotFields, buildReplaceOperations } from './apply.js';
import { saveSnapshot } from './undo.js';
import { startAnnotation, applyContentOperations, validateContent, parseValidateMessages, cancelAnnotation } from './annotationWrite.js';
import { newAcc, foldEvents, replyText, toolLabel } from '../../mdh/agent/agentStream.js';

const MAX_CORRECTIONS = 3;
const errorSig = (errs) => errs.map((e) => `${e.datapointId ?? e.schemaId}:${e.content}`).sort().join('|');
const activity = (ev) => (ev.type === 'reasoning-start' ? 'analyzing the page…'
  : ev.type === 'tool-input-start' ? toolLabel(ev.toolName)
  : ev.type === 'text-delta' ? 'drafting corrections…' : null);

export async function runAnnotate({ annotationId, token, domain, deps, onProgress = () => {} }) {
  const { getJson, getBase64, streamFabry, post, store } = deps;
  onProgress('gather', 'Reading the document…');
  const { changes, chatId, gathered } = await proposeCorrections({
    annotationId, token, domain, deps,
    onEvent: (ev) => { const a = activity(ev); if (a) onProgress('propose', a); },
  });
  if (!changes.length) { onProgress('done', 'No changes needed'); return { applied: [], remaining: [], undoable: false }; }

  // Snapshot originals (from the initial gather) for every datapoint we will touch.
  const touched = new Set(changes.map((c) => c.datapointId));
  let snapshot = snapshotFields(gathered.fields, [...touched]);
  saveSnapshot(annotationId, snapshot, store);

  const applied = [];
  let remaining = [];
  await startAnnotation(annotationId, { post });
  try {
    onProgress('apply', `Applying ${changes.length} correction${changes.length === 1 ? '' : 's'}…`);
    let content = await applyContentOperations(annotationId, buildReplaceOperations(changes), { post });
    applied.push(...changes);
    let fields = flattenFields(content);

    onProgress('validate', 'Checking against master data…');
    remaining = parseValidateMessages(await validateContent(annotationId, { post })).filter((m) => m.type === 'error');

    let prevSig = null;
    for (let i = 0; i < MAX_CORRECTIONS && remaining.length; i++) {
      const sig = errorSig(remaining);
      if (sig === prevSig) break; // no progress
      prevSig = sig;
      onProgress('refine', `Fixing ${remaining.length} issue${remaining.length === 1 ? '' : 's'} — attempt ${i + 1}/${MAX_CORRECTIONS}…`);
      const acc = newAcc();
      await streamFabry({ token, domain, chatId, content: buildFixPrompt({ errors: remaining, fields, schemaFields: gathered.schemaFields }),
        onEvent: (ev) => { foldEvents(acc, [ev]); const a = activity(ev); if (a) onProgress('refine', a); } });
      const fix = diffProposals(resolveBoxes(parseProposal(replyText(acc)), gathered.ocrPages), fields);
      if (!fix.length) break; // agent produced nothing actionable
      // Extend the snapshot with newly-touched datapoints (originals from the initial gather).
      const newIds = fix.map((c) => c.datapointId).filter((id) => !touched.has(id));
      if (newIds.length) { newIds.forEach((id) => touched.add(id)); snapshot = { ...snapshot, ...snapshotFields(gathered.fields, newIds) }; saveSnapshot(annotationId, snapshot, store); }
      content = await applyContentOperations(annotationId, buildReplaceOperations(fix), { post });
      applied.push(...fix);
      fields = flattenFields(content);
      remaining = parseValidateMessages(await validateContent(annotationId, { post })).filter((m) => m.type === 'error');
    }
  } finally {
    await cancelAnnotation(annotationId, { post });
  }
  onProgress('done', `Applied ${applied.length} · ${remaining.length} unresolved`);
  return { applied, remaining, undoable: true };
}
```

- [ ] **Step 4: Run → PASS.**  - [ ] **Step 5: Gate** — `npm test` green.

---

### Task 10: `panel.js` — activity line, result view, Undo + Reload

**Files:** Modify `src/rossum/annotate/panel.js`; Test `tests/annotate-panel.test.js` (extend).

**Interfaces:** add `setActivity(text)` (a muted sub-line under status), `showResult({ applied, remaining })` (renders applied changes with a ✓, remaining errors in red, and mounts an **Undo all** button + a **Reload to view** button), `onUndo(cb)` / `onReload(cb)` (register handlers; buttons call them). Keep `setStatus`/`showError`/`remove`. `showChanges` may remain for the dry-run path/tests.

- [ ] **Step 1: Failing test** (append; file already has the jsdom docblock)

```js
describe('panel result view', () => {
  it('shows applied + remaining and wires Undo/Reload', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    let undone = 0; let reloaded = 0;
    panel.onUndo(() => { undone++; }); panel.onReload(() => { reloaded++; });
    panel.setActivity('analyzing…');
    expect(panel.el.textContent).toContain('analyzing…');
    panel.showResult({
      applied: [{ schemaId: 'd', datapointId: 1, oldValue: 'a', newValue: 'b', boxSource: 'ocr', reason: 'r', valueChanged: true, boxChanged: false }],
      remaining: [{ type: 'error', content: 'still bad', datapointId: 2, schemaId: 'x' }],
    });
    expect(panel.el.textContent).toContain('Applied 1');
    expect(panel.el.textContent).toContain('still bad');
    const btns = panel.el.querySelectorAll('button');
    const undo = [...btns].find((b) => /undo/i.test(b.textContent));
    const reload = [...btns].find((b) => /reload/i.test(b.textContent));
    undo.click(); reload.click();
    expect(undone).toBe(1); expect(reloaded).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — add to `createPanel`:
  - an `activity` div (muted, below `status`): `const activity = doc.createElement('div'); activity.className='rossum-sa-extension-annotate-activity'; el.insertBefore(activity, list);` and `setActivity(text){ activity.textContent = text; }`. Add CSS `.rossum-sa-extension-annotate-activity{color:#666;font-size:11px;margin-bottom:8px;}` and a `.rossum-sa-extension-annotate-btn2{…}` button style to `ensureStyle`.
  - handler holders: `let undoCb=null, reloadCb=null;` + `onUndo(cb){undoCb=cb;} onReload(cb){reloadCb=cb;}`.
  - `showResult({ applied, remaining })`:
    ```js
    clearList();
    status.textContent = `Applied ${applied.length} · ${remaining.length} unresolved`;
    for (const c of applied) {
      const row = doc.createElement('div'); row.className = 'rossum-sa-extension-annotate-row';
      const h = line(row, `✓ ${c.schemaId}${c.rowIndex ? ` (row ${c.rowIndex})` : ''}`); h.style.fontWeight = '700';
      if (c.valueChanged) line(row, `value: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`);
      if (c.boxChanged) { const b = line(row, 'box: redrawn'); const badge = doc.createElement('span'); badge.className='rossum-sa-extension-annotate-badge'; badge.textContent=c.boxSource; b.appendChild(badge); }
      if (c.reason) line(row, c.reason).style.color = '#555';
      list.appendChild(row);
    }
    for (const e of remaining) line(list, `unresolved: ${e.content}`, 'rossum-sa-extension-annotate-err');
    const actions = doc.createElement('div'); actions.style.marginTop = '10px';
    const mk = (label, cb) => { const b = doc.createElement('button'); b.type='button'; b.className='rossum-sa-extension-annotate-btn2'; b.textContent=label; b.addEventListener('click',()=>cb&&cb()); actions.appendChild(b); return b; };
    mk('Undo all', () => undoCb && undoCb());
    mk('Reload to view', () => reloadCb && reloadCb());
    list.appendChild(actions);
    ```

- [ ] **Step 4: Run → PASS** (existing panel tests stay green).
- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 11: `annotate-for-me.js` — wire the write flow

**Files:** Modify `src/rossum/features/annotate-for-me.js`; Test `tests/annotate-feature.test.js` (extend).

**Interfaces:** `run(btn)` now calls `runAnnotate` (auto-apply). It maps `onProgress(phase, detail)` to `panel.setStatus`/`setActivity` (phase → a friendly status; detail → activity line), then `panel.showResult({applied, remaining})`. It wires `panel.onUndo(async () => runUndo({ annotationId, deps: { post: postRossumApi }, onProgress }))` (then re-render / status "Reverted") and `panel.onReload(() => window.location.reload())`. Snapshot persistence is handled inside `runAnnotate`/`runUndo`. Keep the re-entrancy guard, 401 handling, and panel dedup.

- [ ] **Step 1: Failing test** — the `run()` glue is DOM/async-heavy; add a focused test on the progress→status mapping helper. Extract a pure `statusFor(phase, detail)` in the feature module and test it:

```js
import { statusFor } from '../src/rossum/features/annotate-for-me.js';
describe('statusFor', () => {
  it('maps phases to friendly status text', () => {
    expect(statusFor('gather')).toMatch(/reading/i);
    expect(statusFor('apply', 'Applying 2 corrections…')).toBe('Applying 2 corrections…');
    expect(statusFor('done', 'Applied 2 · 0 unresolved')).toBe('Applied 2 · 0 unresolved');
  });
});
```
(Keep the existing `annotationIdFromPath`/`injectButton` tests.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — update imports and `run()`:
  - imports: `import { postRossumApi, getJson, getBase64 } from '../api.js';`, `import { runAnnotate } from '../annotate/loop.js';`, `import { runUndo } from '../annotate/undo.js';`, `import { createPanel, PANEL_ID } from '../annotate/panel.js';`, keep `streamFabry`.
  - add:
    ```js
    export function statusFor(phase, detail) {
      if (detail) return detail;
      return phase === 'gather' ? 'Reading the document…'
        : phase === 'propose' ? 'Mr. Fabry is analyzing…'
        : phase === 'apply' ? 'Applying corrections…'
        : phase === 'validate' ? 'Checking against master data…'
        : phase === 'refine' ? 'Correcting remaining issues…'
        : phase === 'undo' ? 'Reverting…'
        : 'Working…';
    }
    ```
  - `run(btn)` body (replaces the Plan 1 dry-run call):
    ```js
    const annotationId = annotationIdFromPath(window.location.pathname);
    if (!annotationId) return;
    running = true; btn.disabled = true;
    document.getElementById(PANEL_ID)?.remove();
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    panel.onReload(() => window.location.reload());
    panel.onUndo(async () => {
      panel.setStatus('Reverting…');
      try { const { restored } = await runUndo({ annotationId, deps: { post: postRossumApi }, onProgress: (p, d) => panel.setActivity(statusFor(p, d)) }); panel.setStatus(restored ? 'Reverted — reload to view' : 'Nothing to undo'); panel.setActivity(''); }
      catch { panel.setStatus('Undo failed — the annotation may be locked; reload and retry.'); }
    });
    const token = window.localStorage.getItem('secureToken');
    const onProgress = (p, d) => { panel.setStatus(statusFor(p, d && !['apply','validate','refine','done'].includes(p) ? null : d)); if (p === 'propose' || p === 'refine') panel.setActivity(d || ''); };
    try {
      const streamFabryChained = (o) => streamFabry({ ...o, onEvent: (ev) => { if (typeof o.onEvent === 'function') o.onEvent(ev); } });
      const out = await runAnnotate({ annotationId, token, domain: window.location.origin, deps: { getJson, getBase64, streamFabry: streamFabryChained, post: postRossumApi }, onProgress });
      panel.setActivity('');
      panel.showResult({ applied: out.applied, remaining: out.remaining });
    } catch (e) {
      panel.showError(e && e.status === 401 ? 'Session expired — reload the Rossum page.' : 'Could not annotate this document.');
    } finally { running = false; btn.disabled = false; }
    ```
  (Remove the now-unused `runDryRun` import.)

- [ ] **Step 4: Run → PASS** (`tests/annotate-feature.test.js`).
- [ ] **Step 5: Gate** — `npm test` green. Then `npm run build` → clean.

---

### Task 12: Build + manual browser dogfood (owner)

- [ ] **Step 1:** `npm test` (all green) + `npm run build` (clean).
- [ ] **Step 2:** Reload the unpacked extension (`chrome://extensions` ↻), reload the Rossum `/document/<id>` tab.
- [ ] **Step 3:** Click **✨ Annotate for me**. Watch the panel: progress ticks through Reading → analyzing (with live activity) → Applying N → Checking → (Correcting attempt k) → "Applied N · M unresolved". Confirm the doc's fields/boxes changed (reload via the **Reload to view** button).
- [ ] **Step 4:** Click **Undo all** → reload → confirm the annotation is back to its pre-run values/boxes.
- [ ] **Step 5:** Verify a line-item correction landed on the **right row** (not row 0). Note the outcome in `project_annotate_for_me` memory. Leave uncommitted.

---

## Self-Review (against the decisions)

- **Auto-apply** ✅ (Task 11 run() → runAnnotate immediately). **Undo** ✅ (Task 7 snapshot persisted; Task 11 button). **Validate-loop** ✅ (Task 9, cap 3, no-progress stop). **Full line-item** ✅ (Task 2 rowIndex/inLineItem; Task 3 datapoint-id targeting + skip-on-unknown; Task 4 prompt shows dp#/row). **Panel + manual reload** ✅ (Task 10 buttons; no auto-reload). **Rich progress** ✅ (onProgress phases + activity line).
- **Write-safety:** only `replace` ops on known datapoint ids (Task 3 skip + Task 6 builders); start/ops/cancel always released via `finally` (Task 9); never confirm/export/delete. Snapshot before first write; extended before each subsequent write.
- **No placeholders / type consistency:** shapes (`field`+rowIndex/inLineItem, `proposal`+datapointId, `change`+rowIndex, `snapshot`, `operation`, `vmessage`) used consistently across tasks; `proposeCorrections`/`runAnnotate`/`runUndo`/`postRossumApi` signatures match consumers.
- **Backward-compat:** additive to api/gather/proposal/prompt/panel/feature; toggle still off by default; Fabry worker bridge unchanged; dryRun kept as a thin wrapper.

## Known deferrals (documented, not gaps)

- `/persona cautious` prime — still not sent (owner deferred). The server write-lock remains the real read-only ship-blocker before non-dogfood use; document in memory.
- SPA concurrency: writing while the annotation is open holds a review lock; after apply, the user reloads via the button. If the user had unsaved manual edits, a reload discards them — acceptable for dogfood; note in the panel/README if it bites.
- No idle/turn timeout on the Fabry stream (Plan-1 carryover) — a stalled turn hangs "analyzing". Add a 90s abort in a follow-up if it surfaces.
