# "Annotate for me" — Dry-Run Pipeline Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the read-only half of "Annotate for me" — a toggle-gated, in-page button on the Rossum validation screen that gathers the open annotation's fields + OCR spatial data + page images, asks Mr. Fabry (with vision) to propose value/box corrections for the whole document, resolves boxes (snap-to-OCR with pixel fallback), and displays the proposed changes. **No writes.**

**Architecture:** Vanilla-DOM content-script feature (`src/rossum/`) orchestrates pure, unit-tested modules (`src/rossum/annotate/*`). All Rossum API reads are same-origin from the content script. The one cross-origin call — to the Fabry host — is routed through the background service worker over a long-lived port (MV3 forbids the content script from calling it directly), reusing the existing pure SSE parser (`agentStream.js`). Plan 2 adds apply/undo/validate-loop.

**Tech Stack:** esbuild (IIFE bundles, no transpile beyond JSX), Preact **only** in the popup/Console (the Rossum content script is vanilla DOM), `@preact/signals` (not used here), vitest for tests. No TypeScript.

## Global Constraints

- **No TypeScript.** Plain JS + JSX (JSX only in the popup file we touch).
- **Content script is vanilla DOM.** Do NOT import Preact into `src/rossum/**`. Build UI with `document.createElement` + `textContent` (Trusted-Types-safe — no `innerHTML`), matching `src/rossum/features/dataset-mgmt-suggest.js`.
- **Tests:** `.test.js` files in `tests/`, render/execute via `h()` + `vi.mock` (see `reference_vitest_test_jsx_convention`); use condition-based `waitFor`, never fixed `setTimeout` sleeps (see `reference_vitest_flaky_fixed_timeouts`).
- **Off by default.** New toggle `annotateForMeEnabled`; zero overhead when disabled (feature module’s handlers not registered).
- **No customer data leakage.** No document values/names in `console.log` or thrown error messages; the in-page panel shows only the user’s own open document.
- **Commits are owner-batched** (repo convention: features land uncommitted, owner commits — see `feedback_no_commits_during_run`). Each task therefore closes with `npm test` (+ `npm run build` where noted) as its gate, **not** a `git commit` step. Do not run `git commit`.
- **Browser dogfood needs a rebuild.** Tests run against `src/`; the loaded extension runs `dist/`. After UI changes run `npm run build` and reload the extension + the Rossum tab (see `feedback_rebuild_dist_after_ui_changes`).
- **Fabry facts (verified live 2026-07-07):** host `https://rossum-agent-api.tools.rossum.cloud/api/v1` (already in `manifest.json` host_permissions as `https://*.rossum.cloud/*`). Vision via body `{ "content": "<string>", "images": [{ "media_type": "image/png", "data": "<base64-no-prefix>" }] }`; `content` MUST be a string. Auth headers `X-Rossum-Token` + `X-Rossum-Api-Url`. SSE `data: {json}` lines, `data: [DONE]`; parse with `createSseParser`/`foldEvents` from `src/mdh/agent/agentStream.js`.

## Shared data shapes (used across tasks — names are contractual)

```
field      = { datapointId:number, schemaId:string, value:string|null,
               position:[number,number,number,number]|null, page:number|null, confidence:number|null }
ocrPage    = { page:number, width:number, height:number,
               words:[{ text:string, position:[number,number,number,number] }] }
pageImage  = { page:number, mediaType:string, data:string /* base64, no data: prefix */ }
message    = { datapointId:number|null, type:string /* 'error'|'warning'|'info' */, content:string }
schemaField= { schemaId:string, label:string, type:string, required:boolean }
proposal   = { schemaId:string, newValue:string|null, boxWords:string[]|null,
               boxPixels:[number,number,number,number]|null, page:number|null, reason:string, confidence:number|null }
resolved   = proposal & { resolvedBox:[number,number,number,number]|null, boxSource:'ocr'|'pixels'|'none' }
change     = { schemaId:string, datapointId:number|null, oldValue:string|null, newValue:string|null,
               oldBox:[number,number,number,number]|null, newBox:[number,number,number,number]|null,
               page:number|null, boxSource:'ocr'|'pixels'|'none', reason:string, confidence:number|null,
               valueChanged:boolean, boxChanged:boolean }
```

## File Structure

- Create `src/rossum/annotate/gather.js` — read-only fetch + `flattenFields`.
- Create `src/rossum/annotate/prompt.js` — pure prompt builder + OCR scoping.
- Create `src/rossum/annotate/proposal.js` — pure `parseProposal` / `resolveBoxes` / `diffProposals`.
- Create `src/rossum/annotate/fabryBridge.js` — content-side port client → Fabry (via worker).
- Create `src/rossum/annotate/dryRun.js` — pure-ish orchestrator `runDryRun(deps)`.
- Create `src/rossum/annotate/panel.js` — vanilla-DOM result/progress panel.
- Create `src/rossum/features/annotate-for-me.js` — toggle-gated button injection + DOM glue.
- Create `src/background/fabryProxy.js` — worker-side Fabry turn (createChat + streamMessage-with-images).
- Modify `src/rossum/api.js` — add `getJson` (uncached GET) + `getBase64` (blob→base64).
- Modify `src/background/index.js` — add `annotate-fabry` port listener.
- Modify `src/rossum/index.js` — register the feature under `annotateForMeEnabled`.
- Modify `src/popup/components/App.jsx` — add the toggle to the Rossum section.
- Tests: `tests/annotate-gather.test.js`, `annotate-prompt.test.js`, `annotate-proposal.test.js`, `annotate-fabryproxy.test.js`, `annotate-fabrybridge.test.js`, `annotate-dryrun.test.js`, `annotate-panel.test.js`, `annotate-feature.test.js`, and additions to `tests/background.test.js`.

---

### Task 1: `api.js` read helpers (uncached GET + base64 blob)

**Files:**
- Modify: `src/rossum/api.js`
- Test: `tests/annotate-api.test.js`

**Interfaces:**
- Produces: `getJson(path) → Promise<object>` (uncached, token-bearing, same-origin GET); `getBase64(path) → Promise<string>` (same, returns base64 without the `data:` prefix). Both reuse the existing `safeApiUrl` guard.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-api.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getJson, getBase64 } from '../src/rossum/api.js';

beforeEach(() => {
  global.window = { location: { origin: 'https://x.rossum.app' }, localStorage: { getItem: () => 'TKN' } };
});

describe('getJson', () => {
  it('GETs a same-origin api path with the token and returns json', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ a: 1 }) });
    const out = await getJson('/api/v1/annotations/5/content');
    expect(out).toEqual({ a: 1 });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://x.rossum.app/api/v1/annotations/5/content');
    expect(opts.headers.Authorization).toBe('Token TKN');
  });
  it('rejects a non-/api/v1 path', async () => {
    await expect(getJson('/evil')).rejects.toThrow(/Invalid API path/);
  });
  it('throws on non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(getJson('/api/v1/x/1')).rejects.toThrow(/API 403/);
  });
});

describe('getBase64', () => {
  it('fetches a blob and returns base64 without the data prefix', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(bytes.buffer) });
    const b64 = await getBase64('/api/v1/pages/9/preview');
    expect(b64).toBe(btoa(String.fromCharCode(1, 2, 3)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-api.test.js`
Expected: FAIL — `getJson`/`getBase64` are not exported.

- [ ] **Step 3: Add the helpers**

Append to `src/rossum/api.js` (reuse the existing `safeApiUrl`; do not touch `fetchRossumApi`):

```js
function authHeaders() {
  const token = window.localStorage.getItem('secureToken');
  return token ? { Authorization: `Token ${token}` } : {};
}

// Error carrying the HTTP status so callers can branch (e.g. 401 → session expired).
function apiError(status) {
  const e = new Error(`API ${status}`);
  e.status = status;
  return e;
}

// Uncached same-origin GET → parsed JSON. Use when freshness matters (post-write reads).
export function getJson(path) {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  return fetch(url, { headers: authHeaders() }).then((r) => {
    if (!r.ok) throw apiError(r.status);
    return r.json();
  });
}

// Uncached same-origin GET of a binary resource → base64 (no data: prefix).
export function getBase64(path) {
  const url = safeApiUrl(path);
  if (!url) return Promise.reject(new Error(`Invalid API path: ${path}`));
  return fetch(url, { headers: authHeaders() }).then((r) => {
    if (!r.ok) throw apiError(r.status);
    return r.arrayBuffer();
  }).then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-api.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Gate**

Run: `npm test` → all green.

---

### Task 2: `gather.js` — flatten fields + read-only gather

**Files:**
- Create: `src/rossum/annotate/gather.js`
- Test: `tests/annotate-gather.test.js`

**Interfaces:**
- Consumes: `getJson`, `getBase64` (Task 1) — injected as deps for testability.
- Produces: `flattenFields(contentTree) → field[]` (pure); `gatherAnnotation(annotationId, { getJson, getBase64 }) → Promise<{ fields, ocrPages, pageImages, messages, schemaFields }>`.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-gather.test.js
import { describe, it, expect, vi } from 'vitest';
import { flattenFields, gatherAnnotation } from '../src/rossum/annotate/gather.js';

const tree = [
  { category: 'section', children: [
    { category: 'datapoint', id: 11, schema_id: 'document_id',
      content: { value: '123', position: [1, 2, 3, 4], page: 1, rir_confidence: 0.9 } },
    { category: 'multivalue', children: [
      { category: 'tuple', children: [
        { category: 'datapoint', id: 22, schema_id: 'item_desc',
          content: { value: 'x', position: [5, 6, 7, 8], page: 1, rir_confidence: 0.4 } },
      ] },
    ] },
  ] },
];

describe('flattenFields', () => {
  it('walks sections/multivalue/tuple and returns every datapoint', () => {
    const fields = flattenFields(tree);
    expect(fields).toEqual([
      { datapointId: 11, schemaId: 'document_id', value: '123', position: [1, 2, 3, 4], page: 1, confidence: 0.9 },
      { datapointId: 22, schemaId: 'item_desc', value: 'x', position: [5, 6, 7, 8], page: 1, confidence: 0.4 },
    ]);
  });
  it('tolerates missing content', () => {
    expect(flattenFields([{ category: 'datapoint', id: 1, schema_id: 's' }])).toEqual([
      { datapointId: 1, schemaId: 's', value: null, position: null, page: null, confidence: null },
    ]);
  });
});

describe('gatherAnnotation', () => {
  it('fetches content, page_data, pages+images, annotation messages, schema', async () => {
    const getJson = vi.fn((p) => {
      if (p === '/api/v1/annotations/5/content') return Promise.resolve({ content: tree });
      if (p === '/api/v1/annotations/5') return Promise.resolve({
        messages: [{ id: 11, type: 'error', content: 'bad' }],
        schema: 'https://x.rossum.app/api/v1/schemas/7',
      });
      if (p === '/api/v1/annotations/5/page_data?granularity=words') return Promise.resolve({
        results: [{ page_number: 1, items: [{ position: [1, 2, 3, 4], text: 'INV' }] }],
      });
      if (p === '/api/v1/pages?annotation=5') return Promise.resolve({
        results: [{ id: 99, number: 1, width: 1240, height: 1605 }],
      });
      if (p === '/api/v1/schemas/7') return Promise.resolve({
        content: [{ category: 'datapoint', id: 'document_id', label: 'Invoice', type: 'string', constraints: { required: true } }],
      });
      throw new Error('unexpected ' + p);
    });
    const getBase64 = vi.fn(() => Promise.resolve('BASE64'));
    const g = await gatherAnnotation(5, { getJson, getBase64 });
    expect(g.fields).toHaveLength(2);
    expect(g.ocrPages).toEqual([{ page: 1, width: 1240, height: 1605, words: [{ text: 'INV', position: [1, 2, 3, 4] }] }]);
    expect(g.pageImages).toEqual([{ page: 1, mediaType: 'image/png', data: 'BASE64' }]);
    expect(g.messages).toEqual([{ datapointId: 11, type: 'error', content: 'bad' }]);
    expect(g.schemaFields).toEqual([{ schemaId: 'document_id', label: 'Invoice', type: 'string', required: true }]);
    expect(getBase64).toHaveBeenCalledWith('/api/v1/pages/99/preview');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-gather.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `gather.js`**

```js
// src/rossum/annotate/gather.js
// Read-only gather of everything the correction pipeline reasons over. All
// Rossum reads are same-origin (content-script context). Verified shapes:
// content datapoints carry content.{value,position,page,rir_confidence};
// page_data?granularity=words → results[].items[].{position,text};
// pages → results[].{id,number,width,height}; page image at /pages/{id}/preview.

export function flattenFields(nodes) {
  const out = [];
  const walk = (list) => {
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
        });
      } else if (Array.isArray(n.children)) {
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

function schemaIdFromUrl(url) {
  const m = String(url || '').match(/\/schemas\/(\d+)/);
  return m ? m[1] : null;
}

function flattenSchema(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.category === 'datapoint') {
      out.push({ schemaId: n.id, label: n.label || n.id, type: n.type || 'string', required: !!(n.constraints && n.constraints.required) });
    } else if (Array.isArray(n.children)) {
      flattenSchema(n.children, out);
    } else if (n.children && Array.isArray(n.children.children)) {
      flattenSchema(n.children.children, out);
    }
  }
  return out;
}

export async function gatherAnnotation(annotationId, { getJson, getBase64 }) {
  const id = annotationId;
  const [contentRes, annRes, pageDataRes, pagesRes] = await Promise.all([
    getJson(`/api/v1/annotations/${id}/content`),
    getJson(`/api/v1/annotations/${id}`),
    getJson(`/api/v1/annotations/${id}/page_data?granularity=words`),
    getJson(`/api/v1/pages?annotation=${id}`),
  ]);

  const fields = flattenFields(contentRes.content || []);

  const ocrPages = (pageDataRes.results || []).map((p) => ({
    page: p.page_number,
    width: null,
    height: null,
    words: (p.items || []).map((w) => ({ text: w.text, position: w.position })),
  }));

  const pages = (pagesRes.results || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
  for (const pg of pages) {
    const op = ocrPages.find((o) => o.page === pg.number);
    if (op) { op.width = pg.width; op.height = pg.height; }
  }
  const pageImages = await Promise.all(pages.map(async (pg) => ({
    page: pg.number,
    mediaType: 'image/png',
    data: await getBase64(`/api/v1/pages/${pg.id}/preview`),
  })));

  const messages = (annRes.messages || []).map((m) => ({
    datapointId: m.id ?? null, type: m.type, content: m.content,
  }));

  let schemaFields = [];
  const schemaId = schemaIdFromUrl(annRes.schema);
  if (schemaId) {
    const schema = await getJson(`/api/v1/schemas/${schemaId}`);
    schemaFields = flattenSchema(schema.content || []);
  }

  return { fields, ocrPages, pageImages, messages, schemaFields };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-gather.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

> **Verify-before-Plan-2 note (record, do not block):** confirm the persisted `annotation.messages` shape (`id`/`type`/`content`) against an annotation that actually has error messages — the demo test annotation was clean. If the field is `detail`-nested, adjust the `messages` map only.

---

### Task 3: `prompt.js` — pure prompt builder

**Files:**
- Create: `src/rossum/annotate/prompt.js`
- Test: `tests/annotate-prompt.test.js`

**Interfaces:**
- Consumes: `field[]`, `message[]`, `ocrPage[]`, `schemaField[]` (Task 2 shapes).
- Produces: `buildAnnotatePrompt({ fields, messages, ocrPages, schemaFields, maxChars? }) → string` (the text `content`; images are attached separately by the caller). Default `maxChars = 45000` (endpoint rejects >50000).

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-prompt.test.js
import { describe, it, expect } from 'vitest';
import { buildAnnotatePrompt } from '../src/rossum/annotate/prompt.js';

const base = {
  fields: [{ datapointId: 11, schemaId: 'document_id', value: '123', position: [1, 2, 3, 4], page: 1, confidence: 0.9 }],
  messages: [{ datapointId: 11, type: 'error', content: 'wrong id' }],
  ocrPages: [{ page: 1, width: 1240, height: 1605, words: [{ text: 'INV-123', position: [1, 2, 3, 4] }] }],
  schemaFields: [{ schemaId: 'document_id', label: 'Invoice', type: 'string', required: true }],
};

describe('buildAnnotatePrompt', () => {
  it('produces a string that references the fields, errors, schema and JSON output contract', () => {
    const p = buildAnnotatePrompt(base);
    expect(typeof p).toBe('string');
    expect(p).toContain('document_id');
    expect(p).toContain('wrong id');
    expect(p).toContain('box_words');
    expect(p).toContain('schema_id');
    expect(p).toMatch(/json/i);
  });
  it('stays within the char budget by trimming OCR words', () => {
    const words = Array.from({ length: 5000 }, (_, i) => ({ text: 'word' + i, position: [i, i, i + 1, i + 1] }));
    const p = buildAnnotatePrompt({ ...base, ocrPages: [{ page: 1, width: 10, height: 10, words }], maxChars: 2000 });
    expect(p.length).toBeLessThanOrEqual(2000);
    expect(p).toContain('document_id'); // head is always kept
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-prompt.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `prompt.js`**

```js
// src/rossum/annotate/prompt.js
// Pure builder for the Fabry text prompt. The page image (attached separately as
// `images`) carries visual layout; this text carries exact coordinates, current
// values, validation errors and the strict JSON output contract. OCR words are
// the last section so they can be trimmed to fit the char budget.

const OUTPUT_CONTRACT = [
  'You are correcting a Rossum document annotation. You can SEE the page image(s) attached.',
  'For EVERY field that is wrong (value and/or bounding box), output a correction. Leave correct fields out.',
  'Return ONLY a fenced ```json array. Each element:',
  '{ "schema_id": string, "new_value": string, "page": number,',
  '  "box_words": [string, ...]  // OCR word texts the field maps to (preferred), OR',
  '  "box_pixels": [x1,y1,x2,y2], // only if no OCR words cover the region',
  '  "reason": string, "confidence": number }',
  'Coordinates are page pixels; the same coordinate space as the OCR words and current boxes below.',
  'Do NOT call any tools. Output the JSON array and nothing else.',
].join('\n');

function fieldsBlock(fields, schemaFields) {
  const labels = Object.fromEntries((schemaFields || []).map((s) => [s.schemaId, s]));
  return fields.map((f) => {
    const s = labels[f.schemaId] || {};
    const req = s.required ? ' required' : '';
    return `- ${f.schemaId} ("${s.label || f.schemaId}"${req}, ${s.type || '?'}) value=${JSON.stringify(f.value)} `
      + `box=${JSON.stringify(f.position)} page=${f.page} confidence=${f.confidence}`;
  }).join('\n');
}

function errorsBlock(messages) {
  const errs = (messages || []).filter((m) => m.type === 'error' || m.type === 'warning');
  if (!errs.length) return '(none recorded)';
  return errs.map((m) => `- [${m.type}]${m.datapointId != null ? ` dp#${m.datapointId}` : ''}: ${m.content}`).join('\n');
}

function ocrBlock(ocrPages) {
  return (ocrPages || []).map((p) => {
    const lines = p.words.map((w) => `${JSON.stringify(w.text)}@[${w.position.join(',')}]`).join(' ');
    return `# page ${p.page} (${p.width}x${p.height})\n${lines}`;
  }).join('\n');
}

export function buildAnnotatePrompt({ fields, messages, ocrPages, schemaFields, maxChars = 45000 }) {
  const head = [
    OUTPUT_CONTRACT,
    '',
    '## Current fields',
    fieldsBlock(fields, schemaFields),
    '',
    '## Validation errors',
    errorsBlock(messages),
    '',
    '## OCR words (text@[x1,y1,x2,y2], same coordinate space as boxes)',
  ].join('\n');

  const ocr = ocrBlock(ocrPages);
  const sep = '\n';
  const suffix = '\n… (OCR truncated to fit; rely on the page image for the rest)';
  if (head.length + sep.length + ocr.length <= maxChars) return head + sep + ocr; // fits
  const room = maxChars - head.length - sep.length - suffix.length;
  if (room > 0) return head + sep + ocr.slice(0, room) + suffix; // exactly maxChars, suffix intact
  // No room for OCR: keep the head whole (drop OCR); only slice if head alone exceeds the budget.
  return head.length <= maxChars ? head : head.slice(0, maxChars);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-prompt.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 4: `proposal.js` — parse

**Files:**
- Create: `src/rossum/annotate/proposal.js`
- Test: `tests/annotate-proposal.test.js` (parse cases)

**Interfaces:**
- Produces: `parseProposal(replyText) → proposal[]` — tolerant: fenced ```json array first, else first balanced `[ … ]` that parses to an array of objects; unknown keys ignored; returns `[]` on nothing parseable.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-proposal.test.js
import { describe, it, expect } from 'vitest';
import { parseProposal } from '../src/rossum/annotate/proposal.js';

describe('parseProposal', () => {
  it('parses a fenced json array into normalized proposals', () => {
    const reply = 'Here:\n```json\n[{"schema_id":"document_id","new_value":"INV-1","box_words":["INV-1"],"page":1,"reason":"r","confidence":0.8}]\n```';
    expect(parseProposal(reply)).toEqual([
      { schemaId: 'document_id', newValue: 'INV-1', boxWords: ['INV-1'], boxPixels: null, page: 1, reason: 'r', confidence: 0.8 },
    ]);
  });
  it('parses an unfenced array and defaults missing fields', () => {
    const reply = '[{"schema_id":"total","new_value":"9","box_pixels":[1,2,3,4]}]';
    expect(parseProposal(reply)).toEqual([
      { schemaId: 'total', newValue: '9', boxWords: null, boxPixels: [1, 2, 3, 4], page: null, reason: '', confidence: null },
    ]);
  });
  it('returns [] when nothing parseable / no schema_id', () => {
    expect(parseProposal('no json here')).toEqual([]);
    expect(parseProposal('[{"foo":1}]')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-proposal.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parseProposal` (start `proposal.js`)**

```js
// src/rossum/annotate/proposal.js
// Pure: parse Fabry's correction proposals, resolve boxes (hybrid snap-to-OCR /
// pixel fallback), and diff against the current fields. No DOM, no network.
import { stripFences, safeParseArray } from '../../mdh/llmPipeline.js';

// Index of the ']' matching the '[' at `start`, treating brackets inside JSON
// string literals as opaque (a `reason` value containing [ or ] won't truncate).
function balancedArrayEnd(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Non-empty array of plain objects. The length guard matters ONLY for the
// heuristic scan below (skip an incidental `[]` to find the real proposal array);
// the fenced/whole-text steps keep bare Array.isArray so a fenced `[]` = "no changes".
function isObjectArray(a) {
  return Array.isArray(a) && a.length > 0 && a.every((o) => o && typeof o === 'object' && !Array.isArray(o));
}

function firstJsonArray(text) {
  if (typeof text !== 'string') return null;
  // 1. every fenced ```json block (authoritative — accepts empty [])
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text))) { const a = safeParseArray(m[1].trim()); if (Array.isArray(a)) return a; }
  // 2. whole fence-stripped text (authoritative)
  const whole = safeParseArray(stripFences(text).trim());
  if (Array.isArray(whole)) return whole;
  // 3. scan EVERY '[' (string-aware), require a non-empty object array (heuristic)
  for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
    const end = balancedArrayEnd(text, i);
    if (end === -1) continue;
    const a = safeParseArray(text.slice(i, end + 1).trim());
    if (isObjectArray(a)) return a;
  }
  return null;
}

export function parseProposal(replyText) {
  const arr = firstJsonArray(replyText);
  if (!arr) return [];
  return arr
    .filter((o) => o && typeof o === 'object' && typeof o.schema_id === 'string')
    .map((o) => ({
      schemaId: o.schema_id,
      newValue: o.new_value ?? null,
      boxWords: Array.isArray(o.box_words) ? o.box_words.map(String) : null,
      boxPixels: Array.isArray(o.box_pixels) && o.box_pixels.length === 4 ? o.box_pixels.map(Number) : null,
      page: o.page ?? null,
      reason: typeof o.reason === 'string' ? o.reason : '',
      confidence: typeof o.confidence === 'number' ? o.confidence : null,
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-proposal.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 5: `proposal.js` — hybrid box resolution

**Files:**
- Modify: `src/rossum/annotate/proposal.js`
- Test: add to `tests/annotate-proposal.test.js`

**Interfaces:**
- Consumes: `proposal[]` (Task 4), `ocrPage[]` (Task 2).
- Produces: `resolveBoxes(proposals, ocrPages) → resolved[]` — for each proposal: if `boxWords` match OCR words on `page`, `resolvedBox` = union of matched word boxes, `boxSource='ocr'`; else if `boxPixels`, clamp to page bounds, `boxSource='pixels'`; else `resolvedBox=null`, `boxSource='none'`.

- [ ] **Step 1: Write the failing test**

```js
// add to tests/annotate-proposal.test.js
import { resolveBoxes } from '../src/rossum/annotate/proposal.js';

const ocrPages = [{ page: 1, width: 100, height: 100, words: [
  { text: 'INV', position: [10, 10, 30, 20] },
  { text: '123', position: [32, 10, 50, 20] },
] }];

describe('resolveBoxes', () => {
  it('snaps to the union of matched OCR word boxes', () => {
    const r = resolveBoxes([{ schemaId: 'd', newValue: 'INV 123', boxWords: ['INV', '123'], boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages);
    expect(r[0].resolvedBox).toEqual([10, 10, 50, 20]);
    expect(r[0].boxSource).toBe('ocr');
  });
  it('falls back to clamped pixel box when no words match', () => {
    const r = resolveBoxes([{ schemaId: 'd', newValue: 'x', boxWords: ['ZZZ'], boxPixels: [90, 90, 200, 200], page: 1, reason: '', confidence: 1 }], ocrPages);
    expect(r[0].resolvedBox).toEqual([90, 90, 100, 100]); // clamped to page 100x100
    expect(r[0].boxSource).toBe('pixels');
  });
  it('marks none when neither words match nor pixels given', () => {
    const r = resolveBoxes([{ schemaId: 'd', newValue: 'x', boxWords: null, boxPixels: null, page: 1, reason: '', confidence: 1 }], ocrPages);
    expect(r[0].resolvedBox).toBeNull();
    expect(r[0].boxSource).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-proposal.test.js`
Expected: FAIL — `resolveBoxes` not exported.

- [ ] **Step 3: Implement `resolveBoxes`**

```js
// append to src/rossum/annotate/proposal.js
function norm(s) { return String(s).trim().toLowerCase(); }

function unionBox(boxes) {
  return boxes.reduce((a, b) => [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]),
  ]);
}

function clampBox(box, w, h) {
  if (!w || !h) return box.map((n) => Math.max(0, n));
  return [
    Math.max(0, Math.min(box[0], w)), Math.max(0, Math.min(box[1], h)),
    Math.max(0, Math.min(box[2], w)), Math.max(0, Math.min(box[3], h)),
  ];
}

export function resolveBoxes(proposals, ocrPages) {
  const byPage = Object.fromEntries((ocrPages || []).map((p) => [p.page, p]));
  return proposals.map((p) => {
    const page = byPage[p.page];
    if (p.boxWords && p.boxWords.length && page) {
      const remaining = page.words.slice();
      const matched = [];
      for (const tok of p.boxWords) {
        const i = remaining.findIndex((w) => norm(w.text) === norm(tok));
        if (i !== -1) { matched.push(remaining[i].position); remaining.splice(i, 1); }
      }
      if (matched.length) return { ...p, resolvedBox: unionBox(matched), boxSource: 'ocr' };
    }
    if (p.boxPixels) {
      return { ...p, resolvedBox: clampBox(p.boxPixels, page && page.width, page && page.height), boxSource: 'pixels' };
    }
    return { ...p, resolvedBox: null, boxSource: 'none' };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-proposal.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 6: `proposal.js` — diff against current fields

**Files:**
- Modify: `src/rossum/annotate/proposal.js`
- Test: add to `tests/annotate-proposal.test.js`

**Interfaces:**
- Consumes: `resolved[]` (Task 5), `field[]` (Task 2).
- Produces: `diffProposals(resolved, fields) → change[]` — joins each proposal to its field by `schemaId` (first matching field), computes `valueChanged`/`boxChanged`; drops proposals whose schemaId matches no field, and drops entries where neither value nor box changed.

- [ ] **Step 1: Write the failing test**

```js
// add to tests/annotate-proposal.test.js
import { diffProposals } from '../src/rossum/annotate/proposal.js';

const fields = [{ datapointId: 11, schemaId: 'd', value: 'old', position: [10, 10, 30, 20], page: 1, confidence: 0.5 }];

describe('diffProposals', () => {
  it('emits a change with value + box deltas and the datapointId', () => {
    const resolved = [{ schemaId: 'd', newValue: 'new', resolvedBox: [10, 10, 50, 20], boxSource: 'ocr', page: 1, reason: 'r', confidence: 0.9 }];
    expect(diffProposals(resolved, fields)).toEqual([{
      schemaId: 'd', datapointId: 11, oldValue: 'old', newValue: 'new',
      oldBox: [10, 10, 30, 20], newBox: [10, 10, 50, 20], page: 1, boxSource: 'ocr',
      reason: 'r', confidence: 0.9, valueChanged: true, boxChanged: true,
    }]);
  });
  it('drops no-op and unknown-schema proposals', () => {
    const same = [{ schemaId: 'd', newValue: 'old', resolvedBox: [10, 10, 30, 20], boxSource: 'ocr', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(same, fields)).toEqual([]);
    const unknown = [{ schemaId: 'zzz', newValue: 'x', resolvedBox: null, boxSource: 'none', page: 1, reason: '', confidence: 1 }];
    expect(diffProposals(unknown, fields)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-proposal.test.js`
Expected: FAIL — `diffProposals` not exported.

- [ ] **Step 3: Implement `diffProposals`**

```js
// append to src/rossum/annotate/proposal.js
function sameBox(a, b) {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((n, i) => Number(n) === Number(b[i]));
}

export function diffProposals(resolved, fields) {
  const out = [];
  for (const p of resolved) {
    const f = fields.find((x) => x.schemaId === p.schemaId);
    if (!f) continue;
    const newValue = p.newValue;
    const newBox = p.resolvedBox;
    const valueChanged = newValue != null && String(newValue) !== String(f.value ?? '');
    const boxChanged = !!newBox && !sameBox(newBox, f.position);
    if (!valueChanged && !boxChanged) continue;
    out.push({
      schemaId: p.schemaId, datapointId: f.datapointId,
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-proposal.test.js`
Expected: PASS (all proposal tests).

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 7: `fabryProxy.js` — worker-side Fabry turn (with images)

**Files:**
- Create: `src/background/fabryProxy.js`
- Test: `tests/annotate-fabryproxy.test.js`

**Interfaces:**
- Produces: `AGENT_BASE` (const string); `runFabryTurn({ fetchImpl, base, headers, chatId, content, images, onChunk, signal }) → Promise<{ chatId }>` — creates a chat if `chatId` is falsy, POSTs the message with `images` when present (body `{content, images}`), streams the response body, calls `onChunk(text)` per decoded chunk.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-fabryproxy.test.js
import { describe, it, expect, vi } from 'vitest';
import { runFabryTurn, AGENT_BASE } from '../src/background/fabryProxy.js';

function streamOf(chunks) {
  let i = 0;
  const enc = new TextEncoder();
  return { getReader: () => ({ read: () => i < chunks.length
    ? Promise.resolve({ value: enc.encode(chunks[i++]), done: false })
    : Promise.resolve({ value: undefined, done: true }) }) };
}

describe('runFabryTurn', () => {
  it('creates a chat, posts content+images, streams chunks', async () => {
    const calls = [];
    const fetchImpl = vi.fn((url, opts) => {
      calls.push({ url, body: opts.body });
      if (url.endsWith('/chats')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ chat_id: 'c1' }) });
      return Promise.resolve({ ok: true, body: streamOf(['data: {"type":"text-delta","delta":"hi"}\n\n', 'data: [DONE]\n\n']) });
    });
    const chunks = [];
    const out = await runFabryTurn({
      fetchImpl, base: AGENT_BASE, headers: { 'X-Rossum-Token': 't' },
      content: 'hello', images: [{ media_type: 'image/png', data: 'B64' }],
      onChunk: (t) => chunks.push(t),
    });
    expect(out.chatId).toBe('c1');
    expect(calls[0].url).toBe(`${AGENT_BASE}/chats`);
    expect(calls[1].url).toBe(`${AGENT_BASE}/chats/c1/messages`);
    expect(JSON.parse(calls[1].body)).toEqual({ content: 'hello', images: [{ media_type: 'image/png', data: 'B64' }] });
    expect(chunks.join('')).toContain('text-delta');
  });
  it('reuses an existing chatId and omits images when none', async () => {
    const calls = [];
    const fetchImpl = vi.fn((url, opts) => { calls.push({ url, body: opts.body }); return Promise.resolve({ ok: true, body: streamOf(['data: [DONE]\n\n']) }); });
    await runFabryTurn({ fetchImpl, base: AGENT_BASE, headers: {}, chatId: 'c9', content: 'x', onChunk: () => {} });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toEqual({ content: 'x' });
  });
  it('throws on non-ok', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 401 }));
    await expect(runFabryTurn({ fetchImpl, base: AGENT_BASE, headers: {}, chatId: 'c', content: 'x', onChunk: () => {} }))
      .rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-fabryproxy.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fabryProxy.js`**

```js
// src/background/fabryProxy.js
// Worker-side Fabry transport. Lives in the service worker because a content
// script cannot call the cross-origin Fabry host under MV3 CORS; the worker has
// the host permission and a chrome-extension:// origin (which Fabry allows).
// Supports vision: images go in a top-level `images` array (verified 2026-07-07).

export const AGENT_BASE = 'https://rossum-agent-api.tools.rossum.cloud/api/v1';

function agentError(status) {
  const e = new Error(status === 401 ? 'Session expired' : `Agent error ${status}`);
  e.status = status;
  return e;
}

export async function runFabryTurn({ fetchImpl, base, headers, chatId, content, images, onChunk, signal }) {
  const H = { ...headers, 'Content-Type': 'application/json' };
  let id = chatId;
  if (!id) {
    const r = await fetchImpl(`${base}/chats`, { method: 'POST', headers: H, body: '{}', signal });
    if (!r.ok) throw agentError(r.status);
    id = (await r.json()).chat_id;
  }
  const body = JSON.stringify(images && images.length ? { content, images } : { content });
  const r = await fetchImpl(`${base}/chats/${id}/messages`, { method: 'POST', headers: H, body, signal });
  if (!r.ok || !r.body) throw agentError(r.status);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChunk(dec.decode(value, { stream: true }));
  }
  return { chatId: id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-fabryproxy.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 8: Background port listener `annotate-fabry`

**Files:**
- Modify: `src/background/index.js`
- Test: add to `tests/background.test.js`

**Interfaces:**
- Consumes: `runFabryTurn`, `AGENT_BASE` (Task 7).
- Produces: `handleFabryPort(port, deps)` — attaches `onMessage`/`onDisconnect`; on `{type:'start', token, domain, chatId, content, images}` runs a Fabry turn, posting `{type:'chunk',text}` per chunk, `{type:'done',chatId}` on success, `{type:'error',message,status}` on failure. Only honors ports named `annotate-fabry` from the same extension.

- [ ] **Step 1: Write the failing test**

```js
// add to tests/background.test.js
import { handleFabryPort } from '../src/background/index.js';
import { vi, describe, it, expect } from 'vitest';

describe('handleFabryPort', () => {
  it('runs a turn and relays chunk+done', async () => {
    const posted = [];
    const port = {
      name: 'annotate-fabry',
      sender: { id: 'self' },
      postMessage: (m) => posted.push(m),
      onMessage: { addListener: (fn) => (port._msg = fn) },
      onDisconnect: { addListener: () => {} },
    };
    const runFabryTurn = vi.fn(async ({ onChunk }) => { onChunk('data: x\n\n'); return { chatId: 'c1' }; });
    handleFabryPort(port, { extensionId: 'self', runFabryTurn });
    await port._msg({ type: 'start', token: 't', domain: 'https://x.rossum.app', content: 'hi', images: [] });
    expect(posted).toContainEqual({ type: 'chunk', text: 'data: x\n\n' });
    expect(posted).toContainEqual({ type: 'done', chatId: 'c1' });
    const [, args] = runFabryTurn.mock.calls[0];
    expect(runFabryTurn.mock.calls[0][0].headers['X-Rossum-Api-Url']).toBe('https://x.rossum.app/api/v1');
  });
  it('ignores ports from other extensions', () => {
    const port = { name: 'annotate-fabry', sender: { id: 'evil' }, postMessage: () => {}, onMessage: { addListener: () => { throw new Error('should not attach'); } }, onDisconnect: { addListener: () => {} } };
    expect(() => handleFabryPort(port, { extensionId: 'self', runFabryTurn: vi.fn() })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background.test.js`
Expected: FAIL — `handleFabryPort` not exported.

- [ ] **Step 3: Implement in `src/background/index.js`**

Add the import at the top and the handler + wiring (leave the existing `openDatasetManagement` block intact):

```js
import { runFabryTurn as realRunFabryTurn, AGENT_BASE } from './fabryProxy.js';

export function handleFabryPort(port, { extensionId, runFabryTurn }) {
  if (port.name !== 'annotate-fabry') return;
  if (!port.sender || port.sender.id !== extensionId) return; // fail closed: only our own content scripts
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start') return;
    try {
      const { chatId } = await runFabryTurn({
        fetchImpl: fetch, base: AGENT_BASE,
        headers: { 'X-Rossum-Token': msg.token, 'X-Rossum-Api-Url': `${msg.domain}/api/v1` },
        chatId: msg.chatId, content: msg.content, images: msg.images,
        onChunk: (text) => { try { port.postMessage({ type: 'chunk', text }); } catch { /* port closed */ } },
        signal: ctrl.signal,
      });
      try { port.postMessage({ type: 'done', chatId }); } catch { /* port closed */ }
    } catch (e) {
      try { port.postMessage({ type: 'error', message: e.message, status: e.status }); } catch { /* closed */ }
    }
  });
}
```

Then wire it at the bottom, alongside the existing `onMessage` listener:

```js
if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'annotate-fabry') return;
    handleFabryPort(port, { extensionId: chrome.runtime.id, runFabryTurn: realRunFabryTurn });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/background.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 9: `fabryBridge.js` — content-side port client

**Files:**
- Create: `src/rossum/annotate/fabryBridge.js`
- Test: `tests/annotate-fabrybridge.test.js`

**Interfaces:**
- Consumes: `createSseParser` from `src/mdh/agent/agentStream.js` (pure, importable).
- Produces: `streamFabry({ token, domain, chatId, content, images, onEvent, connect }) → Promise<{ chatId }>` — connects the `annotate-fabry` port (via `connect` dep, default `chrome.runtime.connect`), sends `start`, feeds `chunk` text through the SSE parser to `onEvent`, resolves on `done`, rejects on `error`.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-fabrybridge.test.js
import { describe, it, expect, vi } from 'vitest';
import { streamFabry } from '../src/rossum/annotate/fabryBridge.js';

function fakePort() {
  const p = { _msg: null, _disc: null, posted: [], onMessage: { addListener: (fn) => (p._msg = fn) },
    onDisconnect: { addListener: (fn) => (p._disc = fn) }, postMessage: (m) => p.posted.push(m), disconnect: vi.fn() };
  return p;
}

describe('streamFabry', () => {
  it('sends start and resolves with chatId after parsing events', async () => {
    const port = fakePort();
    const events = [];
    const promise = streamFabry({ token: 't', domain: 'd', content: 'hi', images: [], connect: () => port, onEvent: (e) => events.push(e) });
    expect(port.posted[0]).toEqual({ type: 'start', token: 't', domain: 'd', chatId: undefined, content: 'hi', images: [] });
    port._msg({ type: 'chunk', text: 'data: {"type":"text-delta","delta":"hi"}\n\n' });
    port._msg({ type: 'done', chatId: 'c1' });
    await expect(promise).resolves.toEqual({ chatId: 'c1' });
    expect(events).toContainEqual({ type: 'text-delta', delta: 'hi' });
  });
  it('rejects on error message', async () => {
    const port = fakePort();
    const promise = streamFabry({ token: 't', domain: 'd', content: 'x', connect: () => port, onEvent: () => {} });
    port._msg({ type: 'error', message: 'boom', status: 401 });
    await expect(promise).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-fabrybridge.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fabryBridge.js`**

```js
// src/rossum/annotate/fabryBridge.js
// Content-script client for the worker's `annotate-fabry` port. Streams Fabry
// SSE chunks from the worker and parses them with the shared pure parser.
import { createSseParser } from '../../mdh/agent/agentStream.js';

export function streamFabry({ token, domain, chatId, content, images, onEvent = () => {},
  connect = (name) => chrome.runtime.connect({ name }) }) {
  return new Promise((resolve, reject) => {
    const port = connect('annotate-fabry');
    const parser = createSseParser();
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'chunk') { for (const ev of parser.feed(msg.text)) onEvent(ev); }
      else if (msg.type === 'done') { for (const ev of parser.flush()) onEvent(ev); port.disconnect(); resolve({ chatId: msg.chatId }); }
      else if (msg.type === 'error') { port.disconnect(); reject(Object.assign(new Error(msg.message || 'Agent error'), { status: msg.status })); }
    });
    port.onDisconnect.addListener(() => reject(new Error('Agent connection closed')));
    port.postMessage({ type: 'start', token, domain, chatId, content, images });
  });
}
```

> Note: `onDisconnect` rejecting after `resolve`/`reject` is harmless (a settled promise ignores later calls); we call `port.disconnect()` ourselves on done/error.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-fabrybridge.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 10: `dryRun.js` — orchestrator

**Files:**
- Create: `src/rossum/annotate/dryRun.js`
- Test: `tests/annotate-dryrun.test.js`

**Interfaces:**
- Consumes: `gatherAnnotation` (T2), `buildAnnotatePrompt` (T3), `parseProposal`/`resolveBoxes`/`diffProposals` (T4-6), `streamFabry` (T9), `newAcc`/`foldEvents`/`replyText` (agentStream).
- Produces: `runDryRun({ annotationId, token, domain, deps }) → Promise<{ changes, reply, reasoning }>`, where `deps = { getJson, getBase64, streamFabry }` (all injectable for tests).

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-dryrun.test.js
import { describe, it, expect, vi } from 'vitest';
import { runDryRun } from '../src/rossum/annotate/dryRun.js';

describe('runDryRun', () => {
  it('gathers, calls fabry, and returns diffed changes', async () => {
    const getJson = vi.fn((p) => {
      if (p.endsWith('/content')) return Promise.resolve({ content: [
        { category: 'datapoint', id: 11, schema_id: 'd', content: { value: 'old', position: [10, 10, 30, 20], page: 1, rir_confidence: 0.4 } },
      ] });
      if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
      if (p.includes('page_data')) return Promise.resolve({ results: [{ page_number: 1, items: [{ position: [10, 10, 50, 20], text: 'INV-1' }] }] });
      if (p.includes('pages?annotation')) return Promise.resolve({ results: [{ id: 99, number: 1, width: 100, height: 100 }] });
      if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'datapoint', id: 'd', label: 'D', type: 'string' }] });
      throw new Error('x ' + p);
    });
    const getBase64 = vi.fn(() => Promise.resolve('B64'));
    const streamFabry = vi.fn(async ({ onEvent }) => {
      onEvent({ type: 'text-delta', delta: '```json\n[{"schema_id":"d","new_value":"INV-1","box_words":["INV-1"],"page":1,"reason":"fix","confidence":0.9}]\n```' });
      onEvent({ type: '__done__' });
      return { chatId: 'c1' };
    });
    const out = await runDryRun({ annotationId: 5, token: 't', domain: 'https://x.rossum.app', deps: { getJson, getBase64, streamFabry } });
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0]).toMatchObject({ schemaId: 'd', datapointId: 11, newValue: 'INV-1', newBox: [10, 10, 50, 20], boxSource: 'ocr', valueChanged: true, boxChanged: true });
    const call = streamFabry.mock.calls[0][0];
    expect(call.images).toEqual([{ media_type: 'image/png', data: 'B64' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-dryrun.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dryRun.js`**

```js
// src/rossum/annotate/dryRun.js
// Read-only orchestrator: gather → Fabry (vision) → parse → resolve boxes →
// diff. Returns proposed changes; writes NOTHING (Plan 2 adds apply).
import { gatherAnnotation } from './gather.js';
import { buildAnnotatePrompt } from './prompt.js';
import { parseProposal, resolveBoxes, diffProposals } from './proposal.js';
import { newAcc, foldEvents, replyText } from '../../mdh/agent/agentStream.js';

export async function runDryRun({ annotationId, token, domain, deps }) {
  const { getJson, getBase64, streamFabry } = deps;
  const g = await gatherAnnotation(annotationId, { getJson, getBase64 });
  const content = buildAnnotatePrompt({
    fields: g.fields, messages: g.messages, ocrPages: g.ocrPages, schemaFields: g.schemaFields,
  });
  const images = g.pageImages.map((p) => ({ media_type: p.mediaType, data: p.data }));
  const acc = newAcc();
  await streamFabry({ token, domain, content, images, onEvent: (ev) => foldEvents(acc, [ev]) });
  const reply = replyText(acc);
  const changes = diffProposals(resolveBoxes(parseProposal(reply), g.ocrPages), g.fields);
  return { changes, reply, reasoning: acc.reasoning };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-dryrun.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 11: `panel.js` — vanilla-DOM result panel

**Files:**
- Create: `src/rossum/annotate/panel.js`
- Test: `tests/annotate-panel.test.js`

**Interfaces:**
- Produces: `createPanel(doc = document) → { el, setStatus(text), showChanges(changes), showError(text), remove() }`. `el` is a fixed-position container (`id="rossum-sa-extension-annotate-panel"`), Trusted-Types-safe (createElement + textContent only). `showChanges` renders one row per change: `schemaId`, value `old → new`, box `changed?`, source badge, reason.

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-panel.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { createPanel } from '../src/rossum/annotate/panel.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('createPanel', () => {
  it('mounts a panel and renders change rows', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    panel.setStatus('Thinking…');
    expect(panel.el.textContent).toContain('Thinking…');
    panel.showChanges([
      { schemaId: 'd', oldValue: 'old', newValue: 'new', boxSource: 'ocr', reason: 'fix', valueChanged: true, boxChanged: true },
    ]);
    const rows = panel.el.querySelectorAll('.rossum-sa-extension-annotate-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('d');
    expect(rows[0].textContent).toContain('old');
    expect(rows[0].textContent).toContain('new');
    expect(rows[0].textContent.toLowerCase()).toContain('ocr');
  });
  it('shows an empty state and an error', () => {
    const panel = createPanel(document);
    document.body.appendChild(panel.el);
    panel.showChanges([]);
    expect(panel.el.textContent.toLowerCase()).toContain('no changes');
    panel.showError('boom');
    expect(panel.el.textContent).toContain('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-panel.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `panel.js`**

```js
// src/rossum/annotate/panel.js
// Vanilla-DOM, Trusted-Types-safe result panel (no innerHTML). Dry-run: shows
// proposed changes only — no Apply button yet (Plan 2). Injects its own style once.
const PANEL_ID = 'rossum-sa-extension-annotate-panel';
const STYLE_ID = 'rossum-sa-extension-annotate-style';

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
#${PANEL_ID}{position:fixed;top:64px;right:16px;z-index:2147483646;width:min(420px,calc(100vw - 32px));
  max-height:70vh;overflow:auto;background:#fff;color:#1a1a1a;border-radius:10px;
  box-shadow:0 8px 28px rgba(0,0,0,.28);font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:12px;}
#${PANEL_ID} .rossum-sa-extension-annotate-status{font-weight:600;margin-bottom:8px;}
#${PANEL_ID} .rossum-sa-extension-annotate-row{border-top:1px solid #eee;padding:8px 0;}
#${PANEL_ID} .rossum-sa-extension-annotate-badge{display:inline-block;font-size:10px;font-weight:700;
  border-radius:4px;padding:1px 5px;background:#eef2ff;color:#2b4eb8;margin-left:6px;}
#${PANEL_ID} .rossum-sa-extension-annotate-err{color:#b00020;font-weight:600;}`;
  (doc.head || doc.documentElement).appendChild(s);
}

export function createPanel(doc = document) {
  ensureStyle(doc);
  const el = doc.createElement('div');
  el.id = PANEL_ID;
  const status = doc.createElement('div');
  status.className = 'rossum-sa-extension-annotate-status';
  const list = doc.createElement('div');
  el.appendChild(status);
  el.appendChild(list);

  const clearList = () => { while (list.firstChild) list.removeChild(list.firstChild); };
  const line = (parent, text, cls) => { const d = doc.createElement('div'); if (cls) d.className = cls; d.textContent = text; parent.appendChild(d); return d; };

  return {
    el,
    setStatus(text) { status.textContent = text; },
    showError(text) { clearList(); line(list, text, 'rossum-sa-extension-annotate-err'); },
    showChanges(changes) {
      clearList();
      if (!changes.length) { line(list, 'No changes proposed — annotation looks correct.'); return; }
      status.textContent = `${changes.length} proposed change${changes.length === 1 ? '' : 's'} (preview only)`;
      for (const c of changes) {
        const row = doc.createElement('div');
        row.className = 'rossum-sa-extension-annotate-row';
        const head = line(row, c.schemaId);
        head.style.fontWeight = '700';
        if (c.valueChanged) line(row, `value: ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`);
        if (c.boxChanged) {
          const b = line(row, `box: redrawn`);
          const badge = doc.createElement('span');
          badge.className = 'rossum-sa-extension-annotate-badge';
          badge.textContent = c.boxSource;
          b.appendChild(badge);
        }
        if (c.reason) line(row, c.reason).style.color = '#555';
        list.appendChild(row);
      }
    },
    remove() { el.remove(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/annotate-panel.test.js`
Expected: PASS.

- [ ] **Step 5: Gate** — `npm test` green.

---

### Task 12: `annotate-for-me.js` feature — button injection + glue + wiring

**Files:**
- Create: `src/rossum/features/annotate-for-me.js`
- Modify: `src/rossum/index.js`
- Modify: `src/popup/components/App.jsx`
- Test: `tests/annotate-feature.test.js`

**Interfaces:**
- Consumes: `runDryRun` (T10), `createPanel` (T11), `getJson`/`getBase64` (T1), `streamFabry` (T9).
- Produces: `init()` (idempotent; injects the button when on a `/document/<id>` route); `handleNode(node)` (re-asserts the button after SPA mutations); `annotationIdFromPath(pathname)` (exported for tests).

- [ ] **Step 1: Write the failing test**

```js
// tests/annotate-feature.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { annotationIdFromPath, injectButton, BUTTON_ID } from '../src/rossum/features/annotate-for-me.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('annotationIdFromPath', () => {
  it('extracts the annotation id from /document/<id>', () => {
    expect(annotationIdFromPath('/document/138328520')).toBe('138328520');
    expect(annotationIdFromPath('/annotation/999?x=1')).toBe('999');
    expect(annotationIdFromPath('/queues/5')).toBeNull();
  });
});

describe('injectButton', () => {
  it('injects exactly one button and is idempotent', () => {
    injectButton(document, () => {});
    injectButton(document, () => {});
    expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
  });
  it('calls the run handler on click', () => {
    let clicked = 0;
    injectButton(document, () => { clicked++; });
    document.getElementById(BUTTON_ID).click();
    expect(clicked).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/annotate-feature.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `annotate-for-me.js`**

```js
// src/rossum/features/annotate-for-me.js
// Toggle-gated ("annotateForMeEnabled", off by default). On the validation screen
// (/document/<id>) it shows a docked button; clicking runs the READ-ONLY dry-run
// pipeline and shows proposed corrections in a panel. Writes nothing (Plan 2 adds
// apply). Vanilla DOM only. Button placement: viewport-docked (top-right) — a
// selector-independent default; refine to a toolbar anchor once the live DOM is
// confirmed (do NOT guess a Rossum internal selector — see resource-ids precedent).
import { getJson, getBase64 } from '../api.js';
import { streamFabry } from '../annotate/fabryBridge.js';
import { runDryRun } from '../annotate/dryRun.js';
import { createPanel } from '../annotate/panel.js';

export const BUTTON_ID = 'rossum-sa-extension-annotate-btn';
const STYLE_ID = 'rossum-sa-extension-annotate-btn-style';

export function annotationIdFromPath(pathname) {
  const m = String(pathname || '').match(/\/(?:document|annotation)\/(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

export function injectButton(doc, onClick) {
  if (doc.getElementById(BUTTON_ID)) return;
  if (!doc.getElementById(STYLE_ID)) {
    const s = doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `#${BUTTON_ID}{position:fixed;top:16px;right:16px;z-index:2147483646;
      background:linear-gradient(90deg,#7b5cff,#4270db);color:#fff;border:none;border-radius:8px;
      padding:8px 12px;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);}
      #${BUTTON_ID}[disabled]{opacity:.6;cursor:default;}`;
    (doc.head || doc.documentElement).appendChild(s);
  }
  const btn = doc.createElement('button');
  btn.id = BUTTON_ID;
  btn.type = 'button';
  btn.textContent = '✨ Annotate for me';
  btn.addEventListener('click', () => onClick(btn));
  doc.body.appendChild(btn);
}

let running = false;
async function run(btn) {
  if (running) return;
  const annotationId = annotationIdFromPath(window.location.pathname);
  if (!annotationId) return;
  running = true;
  btn.disabled = true;
  const panel = createPanel(document);
  document.body.appendChild(panel.el);
  panel.setStatus('Reading the document…');
  try {
    const out = await runDryRun({
      annotationId, token: window.localStorage.getItem('secureToken'), domain: window.location.origin,
      deps: {
        getJson, getBase64,
        // Chain the caller's onEvent (dryRun folds the stream) with a status tick.
        streamFabry: (o) => streamFabry({
          ...o,
          onEvent: (ev) => {
            if (typeof o.onEvent === 'function') o.onEvent(ev);
            if (ev.type === 'reasoning-start') panel.setStatus('Mr. Fabry is thinking…');
            if (ev.type === 'text-delta') panel.setStatus('Drafting corrections…');
          },
        }),
      },
    });
    panel.showChanges(out.changes);
  } catch (e) {
    panel.showError(e && e.status === 401 ? 'Session expired — reload the Rossum page.' : 'Could not analyze this document.');
  } finally {
    running = false;
    btn.disabled = false;
  }
}

export function init() {
  if (annotationIdFromPath(window.location.pathname)) injectButton(document, run);
}

export function handleNode() {
  // Re-assert the button after SPA re-renders/route changes.
  if (annotationIdFromPath(window.location.pathname)) injectButton(document, run);
  else document.getElementById(BUTTON_ID)?.remove();
}
```

- [ ] **Step 4: Wire into `src/rossum/index.js`**

Add the import and register it (mirroring the other gated features):

```js
import { init as initAnnotateForMe, handleNode as handleAnnotateForMe } from './features/annotate-for-me.js';
```

Add `'annotateForMeEnabled'` to `SETTINGS_KEYS`, and inside the `.then((settings) => {` block, after the existing feature registrations:

```js
  if (settings.annotateForMeEnabled) {
    initAnnotateForMe();
    handlers.push(handleAnnotateForMe);
  }
```

- [ ] **Step 5: Wire the popup toggle in `src/popup/components/App.jsx`**

Add `'annotateForMeEnabled'` to the `STORAGE_TOGGLES` array (the list starting near line 9), and add this `Toggle` inside the Rossum `Behavior` `toggle-group` (after the `scrollLockEnabled` Toggle, before the closing `</div>` at ~line 268):

```jsx
                  <Toggle
                    id="annotateForMeEnabled"
                    label="Annotate for me"
                    hint="Fabry proposes value/box corrections for the open document (preview only)"
                    beta
                    checked={storageValues.annotateForMeEnabled}
                    onChange={(v) => setStorageToggle('annotateForMeEnabled', v)}
                  />
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/annotate-feature.test.js`
Expected: PASS. Then `npm test` → all green.

- [ ] **Step 7: Gate** — `npm test` green.

---

### Task 13: Build + manual browser dogfood

**Files:** none (verification only).

- [ ] **Step 1: Full suite + lint-free build**

Run: `npm test` → all green. Then `npm run build` → completes, writes `dist/`.

- [ ] **Step 2: Load and verify the toggle**

Load/reload the unpacked `dist/` in `chrome://extensions` (reload is required for the new port + any host changes). Open the popup on a Rossum tab → the **Annotate for me** toggle appears under Rossum ▸ Behavior, **off by default**. Turn it on (the tab reloads per the storage-toggle convention).

- [ ] **Step 3: Verify the dry-run on a real annotation**

Reload the Rossum document tab (content scripts don't re-inject into already-open tabs). Open a `/document/<id>` annotation → the **✨ Annotate for me** button appears (top-right). Click it → panel shows "Reading the document…", then "Mr. Fabry is thinking…", then either proposed changes (schema_id, value old→new, box redrawn + source badge, reason) or "No changes proposed". Confirm **nothing is written** (reload the annotation — values/boxes unchanged).

- [ ] **Step 4: Verify the CORS routing**

In DevTools, confirm the Fabry request originates from the **service worker** (not the page) — the content script never fetches `rossum-agent-api.tools.rossum.cloud` directly. If you see a CORS error, the worker port path is misconfigured.

- [ ] **Step 5: Record dogfood outcome**

Note the result in `project_annotate_for_me` memory (worked / issues). Leave uncommitted (owner batches commits).

---

## Self-Review (against the spec)

- **Spec coverage (dry-run subset):** toggle+button (T12), gather content/page_data/image/schema/messages (T2), vision via `images` (T7/T8/dryRun), prompt with scoped OCR + budget (T3), hybrid box precision (T5), whole-document diff (T6), read-only stance (no writes anywhere — apply/undo/loop are explicitly Plan 2), no-leak (panel shows own doc; errors carry no values), backward-compat (off-by-default toggle; additive api/agent changes). CORS-via-worker is a spec §H implication now made explicit.
- **Deferred to Plan 2 (by design):** snapshot + `content/operations` apply, undo, live `content/validate` loop + stop conditions, `refresh document view`, SPA-concurrency handling. Called out so a reviewer doesn't read the omission as a gap.
- **Placeholder scan:** none — every code/test step carries full content.
- **Type consistency:** shape names (`field`/`ocrPage`/`pageImage`/`message`/`schemaField`/`proposal`/`resolved`/`change`) are used identically across T2→T12; `runFabryTurn`/`streamFabry`/`runDryRun`/`createPanel`/`injectButton` signatures match their consumers.
- **Open items recorded (not blocking dry-run):** persisted `annotation.messages` shape (T2 note); button toolbar anchor refinement (T12 note — safe viewport-docked default ships now).

## Execution note on decomposition

This is **Plan 1 of 2**. Plan 2 ("apply + undo + validate-loop") builds on these modules: it adds `src/rossum/annotate/apply.js` (snapshot, `content/operations` build + inverse-undo), a live-validate + refine loop with stop conditions (clean / no-progress / cap 3), and upgrades `panel.js` with Apply/Undo. It is where the first write-to-customer-data lands and must re-confirm SPA concurrency (§10 item ②) before shipping.
