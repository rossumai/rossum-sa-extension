# Annotation Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Annotation Inspector" Console app that, given one annotation, names the culprit (extension / rule / workflow / user / setting) behind every message, automation blocker, rejection, field value, and export failure — with an honest reliability badge on each fact.

**Architecture:** A new read-only Preact sub-app `src/inspector/` rides the existing `src/console/index.jsx` bundle beside `mdh`/`audit`/`galaxy` (no new esbuild entry point). Pure, DOM-free attribution logic lives in `src/inspector/culprit.js` (unit-tested); a thin REST client (`api.js`) mirrors `galaxy/api.js`; components mirror the `audit` app shell and reuse `JsonTree`/`CopyBtn`. Entry is a popup "Inspect this annotation" button that stages the annotation id via the existing `consoleAuth_<uuid>` flow, plus a manual id/URL box.

**Tech Stack:** Preact + @preact/signals (classic JSX runtime, `h`/`Fragment`), esbuild (iife, minify), Vitest + jsdom, Chrome MV3.

**Spec:** `docs/superpowers/specs/2026-06-18-annotation-inspector-design.md`. **Approved mockup (visual source of truth for component JSX/structure):** `.superpowers/brainstorm/49593-1781795585/content/inspector-full.html`.

## Global Constraints

- **No new esbuild entry point** — Inspector bundles through `console/console` (`build.js:33-40`); adding imports in `src/console/index.jsx` suffices.
- **Read-only by default.** The only write is the opt-in "Re-evaluate" action (`start → POST /content/validate → cancel`-in-finally). Core report uses GET only. Never call reject/patch/confirm.
- **Never guess a culprit.** Every fact carries exactly one reliability marker: `verified` | `best-effort` | `unavailable`. When data is missing, state the limit (use the `unavailable` marker), never invent.
- **Tests** live in `tests/*.test.js`, jsdom via top-of-file `// @vitest-environment jsdom`, mount with `render(h(Component, props), root)` (never raw JSX), `vi.mock(...)` API modules, condition-based local `waitFor` (no fixed sleeps). Glob: `tests/**/*.test.js`.
- **CSS** drives off `console.css` `var(--…)` tokens so dark mode works automatically; new rules are prefixed `.inspector-*`.
- **Backward-compat (verified variants):** message `detail` is hook-shape (`hook_id`/`hook_name`) OR rule-shape (`rule_id`/`rule_name`, with `hook_name:"rules"`); blocker `details` uses `message_content` OR `content`, producer name at `detail[0].hook_name` OR `rule_name` (may be absent); blocker items carry both `type` and `level`; blocker `type` vocabulary is open-ended (render unknown types gracefully); do NOT use `automatically_rejected` as the manual/auto flag; rejection reason key is `note_content` and lives in `/v1/notes/{id}`; native rules cannot reject.
- **Git:** work on `master`, no branches/worktrees; commit messages carry **no** `Co-Authored-By: Claude` trailer.
- **CSP:** no `new Function`/`eval`; `dist/console/console.js` must stay clean.

---

## File structure

Create under `src/inspector/`:
- `store.js` — signals (`domain`, `token`, `connected`, `annotationId`, `data`, `enrichment`, `live`, `loading`, `error`) + setters.
- `api.js` — REST client: base (`init`/`get`/`buildQuery`/`listAll`/`safeListAll`/`whoami`) + forensics fetchers + `revalidate`.
- `culprit.js` — pure attribution logic (the value core; fully unit-tested).
- `index.jsx` — `initInspector()` probe-then-load; `loadAnnotation(id)` orchestrator with stale-result guard.
- `components/App.jsx`, `Overview.jsx`, `Timeline.jsx`, `CulpritsSummary.jsx`, `BlockedPanel.jsx`, `RejectedPanel.jsx`, `ProvenancePanel.jsx`, `ExportPanel.jsx`, `ReliabilityBadge.jsx`, `IdInput.jsx`.

Modify (exact line anchors from current tree):
- `src/console/boot.js:5-7`, `src/console/index.jsx` (imports ~18, TITLES ~24, inited flag ~45, ensureInited ~64, no-creds ~105, auth wiring ~121), `src/console/components/Console.jsx:5-10,23-33`, `src/console/components/Rail.jsx` (icon after ~30, APPS ~32-36).
- `src/console/console.css` (append `.inspector-*` section near end), `src/console/console.html` (add a small static markup hook only if needed — App.jsx mounts into the existing `#app`).
- `src/popup/components/App.jsx` (new `onInspectAnnotation` + button), reuse existing `src/popup/tab-readers.js` `readCurrentContext` and `src/popup/utils.js` `openConsoleTab`.

Tests under `tests/`: `inspector-culprit.test.js`, `inspector-api.test.js`, `inspector-index.test.js`, `inspector-components.test.js`, `inspector-popup-launch.test.js`, `inspector-shell.test.js`.

---

## Task 1: Store signals

**Files:**
- Create: `src/inspector/store.js`
- Test: `tests/inspector-store.test.js`

**Interfaces:**
- Produces: exported signals `domain, token, connected, annotationId, data, enrichment, live, loading, error`; setters `reset()`, `setAnnotationId(id)`.
  - `connected`: `null` (unprobed) | `true` | `false`.
  - `data`: `null` | `{ annotation, blocker, content, resolved }` (resolved = `{queue, schema, hooksById, rulesById, usersById}`).
  - `enrichment`: `{ audit:null, hookLogs:null, ruleLogs:null, workflow:null, notes:null, emails:null }` (each `null` until lazily loaded, then array; `'unavailable'` on 403).
  - `live`: `null` | `{ messages, matchedTriggerRules }`.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../src/inspector/store.js';

describe('inspector store', () => {
  beforeEach(() => store.reset());
  it('has connection + data signals with safe initial values', () => {
    expect(store.connected.value).toBe(null);
    expect(store.annotationId.value).toBe(null);
    expect(store.data.value).toBe(null);
    expect(store.enrichment.value).toEqual({
      audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null, emails: null,
    });
    expect(store.loading.value).toBe(false);
  });
  it('setAnnotationId stores the id and clears stale data/error', () => {
    store.error.value = 'boom'; store.data.value = { annotation: {} };
    store.setAnnotationId('133641827');
    expect(store.annotationId.value).toBe('133641827');
    expect(store.data.value).toBe(null);
    expect(store.error.value).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-store.test.js`
Expected: FAIL — cannot find module `src/inspector/store.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/inspector/store.js
import { signal } from '@preact/signals';

// Connection (set by the console shell before initInspector runs).
export const domain = signal('');
export const token = signal('');
export const connected = signal(null); // null = unprobed; true/false after whoami

// What annotation we're inspecting.
export const annotationId = signal(null);

// Core report data + lazily-loaded best-effort enrichment + live re-eval result.
export const data = signal(null);
export const enrichment = signal({
  audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null, emails: null,
});
export const live = signal(null);

export const loading = signal(false);
export const error = signal(null);

export function setAnnotationId(id) {
  annotationId.value = id;
  data.value = null;
  live.value = null;
  enrichment.value = { audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null, emails: null };
  error.value = null;
}

export function reset() {
  annotationId.value = null;
  data.value = null;
  live.value = null;
  enrichment.value = { audit: null, hookLogs: null, ruleLogs: null, workflow: null, notes: null, emails: null };
  loading.value = false;
  error.value = null;
  connected.value = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-store.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inspector/store.js tests/inspector-store.test.js
git commit -m "feat(inspector): store signals"
```

---

## Task 2: API client — base + forensics fetchers

**Files:**
- Create: `src/inspector/api.js`
- Test: `tests/inspector-api.test.js`

**Interfaces:**
- Consumes: nothing (module-level `baseDomain`/`authHeader`).
- Produces:
  - `init(domain, token)`, `whoami({signal})`, `buildQuery(params)`, `get(pathOrUrl, {signal})`, `listAll(pathOrUrl, {signal})`, `safeListAll(pathOrUrl, {signal})`.
  - Forensics core (GET): `getAnnotation(id,{signal})`, `getAutomationBlocker(url,{signal})`, `getContent(id,{signal})`, `getQueue(idOrUrl,{signal})`, `getSchema(idOrUrl,{signal})`, `getHook(idOrUrl,{signal})`, `getRule(idOrUrl,{signal})`, `getUser(idOrUrl,{signal})`.
  - Forensics enrichment (best-effort): `listNotes(annId,{signal})`, `listWorkflowActivities(annId,{signal})`, `listAuditLogs(annId,{signal})`, `listHookLogs(annId,{signal})`, `listRuleExecutionLogs(annId,{signal})`, `listEmails(queueId,{signal})`.
  - `revalidate(id,{signal})` — start → POST `/content/validate` → cancel-in-finally; returns the validate response `{messages, matched_trigger_rules, suggested_operations, updated_datapoints}`.
  - `get` throws `Error` with `.status`; sets `.featureUnavailable=true` on 403; throws "Session expired…" on 401.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as api from '../src/inspector/api.js';

function mockFetch(sequence) {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    const r = sequence[Math.min(i, sequence.length - 1)]; i++;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  });
}

describe('inspector api', () => {
  beforeEach(() => { api.init('https://api.example.rossum.ai', 'TKN'); });

  it('buildQuery skips null/empty', () => {
    expect(api.buildQuery({ a: 1, b: null, c: '', d: 'x' })).toBe('a=1&d=x');
  });

  it('get attaches Bearer + maps 401 to Session expired', async () => {
    mockFetch([{ status: 401, body: {} }]);
    await expect(api.get('/api/v1/annotations/1')).rejects.toThrow(/Session expired/);
    const [, opts] = globalThis.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer TKN');
  });

  it('get flags 403 as featureUnavailable', async () => {
    mockFetch([{ status: 403, body: { detail: 'no' } }]);
    await expect(api.get('/x').catch((e) => { throw e; })).rejects.toMatchObject({ status: 403, featureUnavailable: true });
  });

  it('listAll follows pagination.next', async () => {
    mockFetch([
      { status: 200, body: { results: [1, 2], pagination: { next: 'https://api.example.rossum.ai/p2' } } },
      { status: 200, body: { results: [3], pagination: { next: null } } },
    ]);
    expect(await api.listAll('/api/v1/notes?annotation=9')).toEqual([1, 2, 3]);
  });

  it('safeListAll swallows 403 to []', async () => {
    mockFetch([{ status: 403, body: {} }]);
    expect(await api.safeListAll('/api/v1/audit_logs')).toEqual([]);
  });

  it('getAnnotation hits the annotation path', async () => {
    mockFetch([{ status: 200, body: { id: 5, status: 'to_review' } }]);
    const a = await api.getAnnotation(5);
    expect(a.id).toBe(5);
    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://api.example.rossum.ai/api/v1/annotations/5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-api.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/inspector/api.js
let baseDomain = '';
let authHeader = '';
const REQUEST_TIMEOUT = 30_000;

export function init(domain, token) {
  baseDomain = domain;
  authHeader = `Bearer ${token}`;
}

function toUrl(p) { return /^https?:\/\//.test(p) ? p : `${baseDomain}${p}`; }
function apiError(message, status) { const e = new Error(message); e.status = status; return e; }

function combinedSignal(externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  if (externalSignal) {
    if (externalSignal.aborted) clearTimeout(timer);
    else externalSignal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  return { signal, timer, externalSignal };
}

export async function get(pathOrUrl, { signal: externalSignal } = {}) {
  const { signal, timer, externalSignal: ext } = combinedSignal(externalSignal);
  let res;
  try {
    res = await fetch(toUrl(pathOrUrl), { headers: { Authorization: authHeader, Accept: 'application/json' }, signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') { if (ext?.aborted) throw err; throw apiError('Request timed out after 30s', 0); }
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 401) throw apiError('Session expired. Open a Rossum page and click Inspector again to reconnect.', 401);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = apiError(data?.detail || data?.message || `API error ${res.status}`, res.status);
    if (res.status === 403) err.featureUnavailable = true;
    throw err;
  }
  return data;
}

export function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v == null || v === '') continue; sp.set(k, String(v)); }
  return sp.toString();
}

export async function listAll(pathOrUrl, { signal } = {}) {
  const out = [];
  let next = pathOrUrl;
  while (next) {
    const page = await get(next, { signal });
    if (Array.isArray(page?.results)) out.push(...page.results);
    next = page?.pagination?.next || null;
  }
  return out;
}

export async function safeListAll(pathOrUrl, opts) {
  try { return await listAll(pathOrUrl, opts); }
  catch (err) { if (err.status === 403 || err.status === 404) return []; throw err; }
}

export function whoami({ signal } = {}) { return get('/api/v1/auth/user/', { signal }); }

// ---- forensics: core (GET) ----
export const getAnnotation = (id, o) => get(`/api/v1/annotations/${id}`, o);
export const getAutomationBlocker = (url, o) => get(url, o); // url comes off annotation.automation_blocker
export const getContent = (id, o) => get(`/api/v1/annotations/${id}/content`, o);
export const getQueue = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/queues/${idOrUrl}`, o);
export const getSchema = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/schemas/${idOrUrl}`, o);
export const getHook = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/hooks/${idOrUrl}`, o);
export const getRule = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/rules/${idOrUrl}`, o);
export const getUser = (idOrUrl, o) => get(/^https?:/.test(idOrUrl) ? idOrUrl : `/api/v1/users/${idOrUrl}`, o);

// ---- forensics: enrichment (best-effort; 403/404 -> []) ----
export const listNotes = (annId, o) => safeListAll(`/api/v1/notes?${buildQuery({ annotation: annId, page_size: 100 })}`, o);
export const listWorkflowActivities = (annId, o) => safeListAll(`/api/v1/workflow_activities?${buildQuery({ annotation: annId, page_size: 100 })}`, o);
export const listAuditLogs = (annId, o) => safeListAll(`/api/v1/audit_logs?${buildQuery({ object_type: 'annotation', object_id: annId, page_size: 100 })}`, o);
export const listHookLogs = (annId, o) => safeListAll(`/api/v1/hook_logs?${buildQuery({ annotation: annId, page_size: 100 })}`, o);
export const listRuleExecutionLogs = (annId, o) => safeListAll(`/api/v1/rules_execution_logs?${buildQuery({ annotation_id: annId, page_size: 100 })}`, o);
export const listEmails = (queueId, o) => safeListAll(`/api/v1/emails?${buildQuery({ queue: queueId, type: 'outgoing', page_size: 100 })}`, o);

// ---- live re-evaluate (the only write; start -> validate -> cancel-in-finally) ----
async function post(path, body, { signal } = {}) {
  const { signal: s, timer } = combinedSignal(signal);
  let res;
  try { res = await fetch(toUrl(path), { method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}), signal: s }); }
  finally { clearTimeout(timer); }
  if (res.status === 401) throw apiError('Session expired.', 401);
  if (!res.ok && res.status !== 204) { const d = await res.json().catch(() => null); throw apiError(d?.detail || `API error ${res.status}`, res.status); }
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function revalidate(id, { signal } = {}) {
  await post(`/api/v1/annotations/${id}/start`, {}, { signal });
  try {
    return await post(`/api/v1/annotations/${id}/content/validate`, {}, { signal });
  } finally {
    await post(`/api/v1/annotations/${id}/cancel`, {}, { signal }).catch(() => {}); // tolerate 409
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-api.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inspector/api.js tests/inspector-api.test.js
git commit -m "feat(inspector): REST client (base + forensics fetchers + revalidate)"
```

---

## Task 3: Attribution logic — `culprit.js` part 1 (messages)

**Files:**
- Create: `src/inspector/culprit.js`
- Test: `tests/inspector-culprit.test.js`

**Interfaces:**
- Produces: `REL = {VERIFIED:'verified', BEST_EFFORT:'best-effort', UNAVAILABLE:'unavailable'}`; `classifyMessage(msg)` → `{ level, content, datapointId, culprit:{kind:'hook'|'rule', id, name}|null, isException, requestId, reliability }`.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { REL, classifyMessage } from '../src/inspector/culprit.js';

describe('classifyMessage', () => {
  it('attributes a hook exception to its hook', () => {
    const m = classifyMessage({ type: 'error', content: 'HostNotFound', detail: { hook_id: 1791439, hook_name: 'Pre: Duplicate detector', request_id: 'r1', is_exception: true } });
    expect(m).toMatchObject({ level: 'error', isException: true, requestId: 'r1', datapointId: null, culprit: { kind: 'hook', id: 1791439, name: 'Pre: Duplicate detector' }, reliability: REL.VERIFIED });
  });
  it('attributes a rule message to its rule (hook_name:"rules", hook_id null) and captures datapoint id', () => {
    const m = classifyMessage({ type: 'warning', content: 'X', id: '18584171175', detail: { rule_id: 234, rule_name: 'Amount cross-check', hook_id: null, hook_name: 'rules', is_exception: false } });
    expect(m.culprit).toEqual({ kind: 'rule', id: 234, name: 'Amount cross-check' });
    expect(m.datapointId).toBe('18584171175');
    expect(m.isException).toBe(false);
  });
  it('marks an unattributable message unavailable, never guesses', () => {
    const m = classifyMessage({ type: 'info', content: 'legacy', detail: {} });
    expect(m.culprit).toBe(null);
    expect(m.reliability).toBe(REL.UNAVAILABLE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-culprit.test.js`
Expected: FAIL — module/export not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/inspector/culprit.js
export const REL = { VERIFIED: 'verified', BEST_EFFORT: 'best-effort', UNAVAILABLE: 'unavailable' };

export function classifyMessage(msg) {
  const d = msg?.detail || {};
  let culprit = null;
  if (d.rule_id != null) culprit = { kind: 'rule', id: d.rule_id, name: d.rule_name || `rule ${d.rule_id}` };
  else if (d.hook_id != null) culprit = { kind: 'hook', id: d.hook_id, name: d.hook_name || `hook ${d.hook_id}` };
  return {
    level: msg?.type || 'info',
    content: msg?.content || '',
    datapointId: msg?.id != null ? String(msg.id) : null,
    culprit,
    isException: !!d.is_exception,
    requestId: d.request_id || null,
    reliability: culprit ? REL.VERIFIED : REL.UNAVAILABLE,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-culprit.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inspector/culprit.js tests/inspector-culprit.test.js
git commit -m "feat(inspector): classifyMessage attribution"
```

---

## Task 4: `culprit.js` part 2 — `explainBlocker`

**Files:**
- Modify: `src/inspector/culprit.js`
- Test: `tests/inspector-culprit.test.js` (append)

**Interfaces:**
- Consumes: `REL`.
- Produces: `explainBlocker(item, ctx)` where `ctx = { queue, schemaById }` → `{ type, level, schemaId, datapointId, explanation, culprit:{kind,id|null,name}|null, reliability }`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { explainBlocker } from '../src/inspector/culprit.js';

describe('explainBlocker', () => {
  const ctx = { queue: { automation_level: 'never', default_score_threshold: 0.8 }, schemaById: {} };
  it('explains low_score with score vs threshold and blames the engine', () => {
    const b = explainBlocker({ type: 'low_score', level: 'datapoint', schema_id: 'recipient_name', samples: [{ datapoint_id: 1, details: { score: 0.58, threshold: 0.8 } }] }, ctx);
    expect(b.schemaId).toBe('recipient_name');
    expect(b.culprit).toEqual({ kind: 'engine', id: null, name: 'extraction engine' });
    expect(b.explanation).toMatch(/0\.58.*0\.8/);
    expect(b.reliability).toBe(REL.VERIFIED);
  });
  it('blames the queue config for automation_disabled', () => {
    const b = explainBlocker({ type: 'automation_disabled', level: 'annotation' }, ctx);
    expect(b.culprit.kind).toBe('queue');
    expect(b.explanation).toMatch(/never/);
  });
  it('reads producer name from details.detail[0].rule_name or hook_name (best-effort)', () => {
    const b = explainBlocker({ type: 'failed_checks', level: 'datapoint', schema_id: 'x', details: { detail: [{ rule_name: 'My Rule' }] } }, ctx);
    expect(b.culprit).toEqual({ kind: 'rule', id: null, name: 'My Rule' });
    expect(b.reliability).toBe(REL.BEST_EFFORT);
  });
  it('renders unknown blocker types gracefully', () => {
    const b = explainBlocker({ type: 'some_future_type', level: 'annotation' }, ctx);
    expect(b.type).toBe('some_future_type');
    expect(b.explanation).toBeTruthy();
    expect(b.culprit).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-culprit.test.js`
Expected: FAIL — `explainBlocker` not exported.

- [ ] **Step 3: Write minimal implementation (append to culprit.js)**

```js
export function explainBlocker(item, ctx = {}) {
  const type = item?.type || 'unknown';
  const level = item?.level || null;
  const schemaId = item?.schema_id || null;
  const sample = Array.isArray(item?.samples) ? item.samples[0] : null;
  const datapointId = sample?.datapoint_id != null ? String(sample.datapoint_id) : null;

  // Best-effort producer name from the optional details.detail[0]
  const det = Array.isArray(item?.details?.detail) ? item.details.detail[0] : null;
  let culprit = null;
  let reliability = REL.VERIFIED;
  let explanation = '';

  if (type === 'low_score') {
    const score = sample?.details?.score;
    const threshold = sample?.details?.threshold ?? ctx.queue?.default_score_threshold;
    explanation = `Extraction confidence ${fmtNum(score)} is below the threshold ${fmtNum(threshold)}.`;
    culprit = { kind: 'engine', id: null, name: 'extraction engine' };
  } else if (type === 'automation_disabled') {
    explanation = `Queue automation is off (automation_level: "${ctx.queue?.automation_level ?? 'unknown'}").`;
    culprit = { kind: 'queue', id: null, name: 'queue configuration' };
  } else if (type === 'error_message') {
    explanation = 'One or more error messages are present (see the messages below); any error blocks automation.';
  } else if (det && (det.rule_name || det.hook_name)) {
    culprit = det.rule_name ? { kind: 'rule', id: null, name: det.rule_name } : { kind: 'hook', id: null, name: det.hook_name };
    reliability = REL.BEST_EFFORT;
    explanation = `Blocker of type "${type}" on ${schemaId || 'the annotation'}.`;
  } else {
    explanation = `Blocker of type "${type}"${schemaId ? ` on field ${schemaId}` : ''}.`;
  }
  return { type, level, schemaId, datapointId, explanation, culprit, reliability };
}

function fmtNum(n) { return typeof n === 'number' ? (Math.round(n * 100) / 100).toString() : String(n ?? '?'); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-culprit.test.js`
Expected: PASS (all blocker + message tests).

- [ ] **Step 5: Commit**

```bash
git add src/inspector/culprit.js tests/inspector-culprit.test.js
git commit -m "feat(inspector): explainBlocker with open-ended type tolerance"
```

---

## Task 5: `culprit.js` part 3 — `classifyRejection`

**Files:**
- Modify: `src/inspector/culprit.js`
- Test: `tests/inspector-culprit.test.js` (append)

**Interfaces:**
- Produces: `classifyRejection({ annotation, workflowActivities, notes, usersById })` → `{ current, historical, type:'manual'|'workflow'|'hook'|'none', culprit:{kind,id|null,name|null}|null, reason:{text|null, reliability}, when, automatic, reliability }`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { classifyRejection } from '../src/inspector/culprit.js';

describe('classifyRejection', () => {
  it('manual: blames the user from rejected_by, reason from notes', () => {
    const r = classifyRejection({
      annotation: { status: 'rejected', rejected_at: 'T', rejected_by: 'https://h/api/v1/users/7', automatically_rejected: false },
      workflowActivities: [],
      notes: [{ type: 'rejection', content: 'dup', creator: 'https://h/api/v1/users/7' }],
      usersById: { 7: { username: 'jr@acme.com' } },
    });
    expect(r.current).toBe(true);
    expect(r.type).toBe('manual');
    expect(r.culprit).toMatchObject({ kind: 'user', name: 'jr@acme.com' });
    expect(r.reason).toEqual({ text: 'dup', reliability: REL.VERIFIED });
  });
  it('workflow: blames the workflow even though automatically_rejected is false', () => {
    const r = classifyRejection({
      annotation: { status: 'confirmed', rejected_at: 'T', rejected_by: null, automatically_rejected: false },
      workflowActivities: [{ action: 'rejected', note: 'no step matched', workflow: 'https://h/api/v1/workflows/35' }],
      notes: [],
    });
    expect(r.historical).toBe(true);
    expect(r.type).toBe('workflow');
    expect(r.culprit).toMatchObject({ kind: 'workflow', id: '35' });
    expect(r.reason.text).toBe('no step matched');
  });
  it('hook: automatically_rejected true + service identity, exact extension best-effort', () => {
    const r = classifyRejection({
      annotation: { status: 'rejected', rejected_at: 'T', rejected_by: 'https://h/api/v1/users/9', automatically_rejected: true },
      workflowActivities: [], notes: [], usersById: { 9: { username: 'svc-bot' } },
    });
    expect(r.type).toBe('hook');
    expect(r.culprit).toMatchObject({ kind: 'extension', name: 'svc-bot' });
    expect(r.reliability).toBe(REL.BEST_EFFORT);
  });
  it('not rejected', () => {
    const r = classifyRejection({ annotation: { status: 'to_review', rejected_at: null }, workflowActivities: [], notes: [] });
    expect(r.type).toBe('none'); expect(r.current).toBe(false); expect(r.historical).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-culprit.test.js`
Expected: FAIL — `classifyRejection` not exported.

- [ ] **Step 3: Write minimal implementation (append)**

```js
function userName(url, usersById) {
  const id = idFromUrl(url);
  return usersById?.[id]?.username || (url ? `user ${id}` : null);
}
function idFromUrl(url) { const m = String(url || '').match(/\/(\d+)\/?$/); return m ? m[1] : null; }

export function classifyRejection({ annotation = {}, workflowActivities = [], notes = [], usersById = {} } = {}) {
  const current = annotation.status === 'rejected';
  const historical = current || !!annotation.rejected_at;
  const wfReject = (workflowActivities || []).find((a) => a.action === 'rejected');
  const rejNote = (notes || []).find((n) => n.type === 'rejection');
  const reason = rejNote
    ? { text: rejNote.content || null, reliability: REL.VERIFIED }
    : (wfReject ? { text: wfReject.note || null, reliability: REL.VERIFIED } : { text: null, reliability: REL.UNAVAILABLE });

  if (!historical) return { current, historical, type: 'none', culprit: null, reason: { text: null, reliability: REL.UNAVAILABLE }, when: null, automatic: false, reliability: REL.VERIFIED };

  // Workflow signature wins: a rejected workflow_activity, regardless of automatically_rejected.
  if (wfReject) {
    return {
      current, historical, type: 'workflow',
      culprit: { kind: 'workflow', id: idFromUrl(wfReject.workflow), name: wfReject.workflow ? `Workflow #${idFromUrl(wfReject.workflow)}` : 'approval workflow' },
      reason, when: annotation.rejected_at || null,
      automatic: wfReject.created_by == null, reliability: REL.VERIFIED,
    };
  }
  // Hook/API-driven: explicitly flagged automatic; exact extension is best-effort (needs log correlation).
  if (annotation.automatically_rejected === true) {
    return {
      current, historical, type: 'hook',
      culprit: { kind: 'extension', id: idFromUrl(annotation.rejected_by), name: userName(annotation.rejected_by, usersById) || 'automated identity' },
      reason, when: annotation.rejected_at || null, automatic: true, reliability: REL.BEST_EFFORT,
    };
  }
  // Otherwise a person rejected it.
  return {
    current, historical, type: 'manual',
    culprit: { kind: 'user', id: idFromUrl(annotation.rejected_by), name: userName(annotation.rejected_by, usersById) || 'a reviewer' },
    reason, when: annotation.rejected_at || null, automatic: false, reliability: REL.VERIFIED,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-culprit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inspector/culprit.js tests/inspector-culprit.test.js
git commit -m "feat(inspector): classifyRejection taxonomy (manual/workflow/hook)"
```

---

## Task 6: `culprit.js` part 4 — provenance, capability scan, candidate ranking, aggregate

**Files:**
- Modify: `src/inspector/culprit.js`
- Test: `tests/inspector-culprit.test.js` (append)

**Interfaces:**
- Produces:
  - `fieldProvenance(datapoint)` → `{ schemaId, value, sources, primary, confidence, expandableToHook }`.
  - `detectRejectCapability(hook)` → `'calls-reject' | 'no-reject-call' | 'unknown-webhook'`.
  - `rankRejectCandidates({ hookLogs, queueHooks, rejectedAt, requestId })` → sorted `[{ hookId, name, capability, ran, matchedRequestId, score }]`.
  - `aggregateCulprits({ messages, blockers, rejection })` → `[{ key, kind, id, name, count, reliability }]`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { fieldProvenance, detectRejectCapability, rankRejectCandidates, aggregateCulprits } from '../src/inspector/culprit.js';

describe('provenance + detective', () => {
  it('buckets a field value to its primary source', () => {
    const p = fieldProvenance({ schema_id: 'amount_total', validation_sources: ['score'], content: { value: '5', rir_confidence: 0.97 } });
    expect(p).toMatchObject({ schemaId: 'amount_total', primary: 'score', confidence: 0.97 });
    const h = fieldProvenance({ schema_id: 'x', validation_sources: ['score', 'human'], content: { value: 'a' } });
    expect(h.primary).toBe('human'); // human edit dominates
    const c = fieldProvenance({ schema_id: 'y', validation_sources: ['connector'], content: { value: 'b' } });
    expect(c.expandableToHook).toBe(true);
  });
  it('detects reject capability without guessing webhooks', () => {
    expect(detectRejectCapability({ type: 'function', config: { code: 'requests.post(f"{base}/annotations/{id}/reject")' } })).toBe('calls-reject');
    expect(detectRejectCapability({ type: 'function', config: { code: 'return {"messages": []}' } })).toBe('no-reject-call');
    expect(detectRejectCapability({ type: 'webhook', config: { url: 'https://x' } })).toBe('unknown-webhook');
  });
  it('ranks the request_id match first', () => {
    const ranked = rankRejectCandidates({
      hookLogs: [{ hook: 11, request_id: 'RID' }],
      queueHooks: [{ id: 11, name: 'ERP guard', type: 'function', config: { code: 'x/reject' } }, { id: 12, name: 'Other', type: 'webhook', config: {} }],
      rejectedAt: 'T', requestId: 'RID',
    });
    expect(ranked[0]).toMatchObject({ hookId: 11, matchedRequestId: true });
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
  it('aggregates distinct culprits with counts', () => {
    const agg = aggregateCulprits({
      messages: [{ culprit: { kind: 'hook', id: 1, name: 'A' } }, { culprit: { kind: 'hook', id: 1, name: 'A' } }],
      blockers: [{ culprit: { kind: 'engine', id: null, name: 'extraction engine' } }],
      rejection: { type: 'none', culprit: null },
    });
    const a = agg.find((x) => x.name === 'A');
    expect(a.count).toBe(2);
    expect(agg.some((x) => x.kind === 'engine')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-culprit.test.js`
Expected: FAIL — exports missing.

- [ ] **Step 3: Write minimal implementation (append)**

```js
export function fieldProvenance(dp) {
  const sources = Array.isArray(dp?.validation_sources) ? dp.validation_sources : [];
  const primary = sources.includes('human') ? 'human'
    : sources.includes('connector') ? 'connector'
    : sources.includes('score') ? 'score'
    : (sources[0] || 'unknown');
  return {
    schemaId: dp?.schema_id || null,
    value: dp?.content?.value ?? null,
    sources,
    primary,
    confidence: typeof dp?.content?.rir_confidence === 'number' ? dp.content.rir_confidence : null,
    expandableToHook: primary === 'connector',
  };
}

export function detectRejectCapability(hook) {
  if (hook?.type === 'webhook') return 'unknown-webhook';
  const code = hook?.config?.code || '';
  return /\/reject\b/.test(code) || /['"]rejected['"]/.test(code) ? 'calls-reject' : 'no-reject-call';
}

export function rankRejectCandidates({ hookLogs = [], queueHooks = [], rejectedAt = null, requestId = null } = {}) {
  const ranById = new Map();
  for (const l of hookLogs) ranById.set(l.hook, l);
  return (queueHooks || [])
    .map((h) => {
      const log = ranById.get(h.id);
      const matchedRequestId = !!(requestId && log && log.request_id === requestId);
      const capability = detectRejectCapability(h);
      let score = 0;
      if (matchedRequestId) score += 100;
      if (log) score += 20;
      if (capability === 'calls-reject') score += 30;
      else if (capability === 'unknown-webhook') score += 5;
      return { hookId: h.id, name: h.name, capability, ran: !!log, matchedRequestId, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function aggregateCulprits({ messages = [], blockers = [], rejection = null } = {}) {
  const byKey = new Map();
  const add = (c, reliability) => {
    if (!c) return;
    const key = `${c.kind}:${c.id ?? c.name}`;
    const cur = byKey.get(key) || { key, kind: c.kind, id: c.id ?? null, name: c.name, count: 0, reliability: reliability || 'verified' };
    cur.count += 1;
    if (reliability === 'best-effort') cur.reliability = 'best-effort';
    byKey.set(key, cur);
  };
  for (const m of messages) add(m.culprit, m.reliability);
  for (const b of blockers) add(b.culprit, b.reliability);
  if (rejection && rejection.type !== 'none') add(rejection.culprit, rejection.reliability);
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-culprit.test.js`
Expected: PASS (full culprit suite).

- [ ] **Step 5: Commit**

```bash
git add src/inspector/culprit.js tests/inspector-culprit.test.js
git commit -m "feat(inspector): provenance, capability scan, candidate ranking, aggregate"
```

---

## Task 7: Orchestrator — `index.jsx` (`initInspector` + `loadAnnotation`)

**Files:**
- Create: `src/inspector/index.jsx`
- Test: `tests/inspector-index.test.js`

**Interfaces:**
- Consumes: `api.*`, `store.*`.
- Produces: `initInspector()` (probe whoami → set `connected`; if `annotationId` already staged, load it); `loadAnnotation(id)` (core GET fan-out → `store.data`; stale-result guarded by a module `loadId` counter); `loadEnrichment(kind)` (lazy best-effort); `runRevalidate()`.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/inspector/api.js');
import * as api from '../src/inspector/api.js';
import * as store from '../src/inspector/store.js';
import { initInspector, loadAnnotation } from '../src/inspector/index.jsx';

beforeEach(() => { store.reset(); vi.clearAllMocks(); });

it('initInspector flips connected false on whoami failure', async () => {
  api.whoami.mockRejectedValue(Object.assign(new Error('Session expired'), { status: 401 }));
  await initInspector();
  expect(store.connected.value).toBe(false);
});

it('loadAnnotation populates data from core GETs (blocker followed from URL)', async () => {
  api.getAnnotation.mockResolvedValue({ id: 5, status: 'to_review', messages: [], automation_blocker: 'https://h/api/v1/automation_blockers/9', queue: 'https://h/api/v1/queues/3', schema: 'https://h/api/v1/schemas/7' });
  api.getAutomationBlocker.mockResolvedValue({ content: [{ type: 'low_score' }] });
  api.getContent.mockResolvedValue({ content: [] });
  api.getQueue.mockResolvedValue({ id: 3, automation_level: 'never' });
  api.getSchema.mockResolvedValue({ content: [] });
  store.setAnnotationId('5');
  await loadAnnotation('5');
  expect(store.data.value.annotation.id).toBe(5);
  expect(store.data.value.blocker.content[0].type).toBe('low_score');
  expect(api.getAutomationBlocker).toHaveBeenCalledWith('https://h/api/v1/automation_blockers/9', expect.anything());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-index.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```jsx
// src/inspector/index.jsx
import * as api from './api.js';
import * as store from './store.js';

let loadId = 0;

export async function initInspector() {
  try { await api.whoami(); }
  catch (err) { store.error.value = err.message || 'Failed to verify session'; store.connected.value = false; return; }
  store.connected.value = true;
  if (store.annotationId.value) loadAnnotation(store.annotationId.value); // not awaited
}

export async function loadAnnotation(id) {
  const myId = ++loadId;
  store.loading.value = true; store.error.value = null;
  try {
    const annotation = await api.getAnnotation(id);
    if (myId !== loadId) return;
    const [blocker, content, queue, schema] = await Promise.all([
      annotation.automation_blocker ? api.getAutomationBlocker(annotation.automation_blocker).catch(() => null) : Promise.resolve(null),
      api.getContent(id).catch(() => null),
      annotation.queue ? api.getQueue(annotation.queue).catch(() => null) : Promise.resolve(null),
      annotation.schema ? api.getSchema(annotation.schema).catch(() => null) : Promise.resolve(null),
    ]);
    if (myId !== loadId) return;
    store.data.value = { annotation, blocker, content, resolved: { queue, schema, usersById: {}, hooksById: {}, rulesById: {} } };
  } catch (err) {
    if (myId === loadId) store.error.value = err.message || 'Failed to load annotation';
  } finally {
    if (myId === loadId) store.loading.value = false;
  }
}

export async function loadEnrichment(kind) {
  const id = store.annotationId.value;
  const fns = {
    notes: () => api.listNotes(id), workflow: () => api.listWorkflowActivities(id),
    audit: () => api.listAuditLogs(id), hookLogs: () => api.listHookLogs(id),
    ruleLogs: () => api.listRuleExecutionLogs(id),
  };
  if (!fns[kind]) return;
  try { const v = await fns[kind](); store.enrichment.value = { ...store.enrichment.value, [kind]: v }; }
  catch (err) { store.enrichment.value = { ...store.enrichment.value, [kind]: err.featureUnavailable ? 'unavailable' : [] }; }
}

export async function runRevalidate() {
  const id = store.annotationId.value;
  const res = await api.revalidate(id);
  store.live.value = { messages: res?.messages || [], matchedTriggerRules: res?.matched_trigger_rules || [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-index.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inspector/index.jsx tests/inspector-index.test.js
git commit -m "feat(inspector): initInspector + loadAnnotation orchestrator"
```

---

## Task 8: Presentational atoms — `ReliabilityBadge` + `IdInput`

**Files:**
- Create: `src/inspector/components/ReliabilityBadge.jsx`, `src/inspector/components/IdInput.jsx`
- Test: `tests/inspector-components.test.js`

**Interfaces:**
- Produces: `ReliabilityBadge({ level })` (default export) — renders `verified`/`best-effort`/`unavailable` with classes `inspector-rb inspector-rb-<level>`. `IdInput({ onSubmit })` — parses a pasted id OR Rossum URL (`/document/{id}` or `/annotations/{id}`) and calls `onSubmit(id)`.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';
import ReliabilityBadge from '../src/inspector/components/ReliabilityBadge.jsx';
import IdInput from '../src/inspector/components/IdInput.jsx';

let root;
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); });
afterEach(() => { render(null, root); root.remove(); });

it('renders the right badge class', () => {
  render(h(ReliabilityBadge, { level: 'best-effort' }), root);
  expect(root.querySelector('.inspector-rb-best-effort')).toBeTruthy();
});
it('IdInput extracts the id from a Rossum URL', () => {
  const onSubmit = vi.fn();
  render(h(IdInput, { onSubmit }), root);
  const input = root.querySelector('input');
  input.value = 'https://acme.rossum.app/document/133641827';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(onSubmit).toHaveBeenCalledWith('133641827');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-components.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

```jsx
// src/inspector/components/ReliabilityBadge.jsx
import { h } from 'preact';
const LABEL = { verified: 'Verified', 'best-effort': 'Best-effort', unavailable: 'Not recorded' };
export default function ReliabilityBadge({ level }) {
  if (!level) return null;
  return <span class={`inspector-rb inspector-rb-${level}`}>{LABEL[level] || level}</span>;
}
```

```jsx
// src/inspector/components/IdInput.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
function parseId(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/\/document\/(\d+)/) || s.match(/\/annotations?\/(\d+)/) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}
export default function IdInput({ onSubmit }) {
  const [val, setVal] = useState('');
  return (
    <form class="inspector-idform" onSubmit={(e) => { e.preventDefault(); const id = parseId(val); if (id) onSubmit(id); }}>
      <input class="inspector-idinput" value={val} placeholder="Annotation id or Rossum URL"
why        onInput={(e) => setVal(e.target.value)} />
      <button class="btn btn-primary" type="submit">Inspect</button>
    </form>
  );
}
```

> NOTE for implementer: remove the stray `why` token before `onInput` (artifact). The attribute must read `onInput={(e) => setVal(e.target.value)}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-components.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inspector/components/ReliabilityBadge.jsx src/inspector/components/IdInput.jsx tests/inspector-components.test.js
git commit -m "feat(inspector): ReliabilityBadge + IdInput atoms"
```

---

## Task 9: Panels + App shell

**Files:**
- Create: `src/inspector/components/{Overview,Timeline,CulpritsSummary,BlockedPanel,RejectedPanel,ProvenancePanel,ExportPanel,App}.jsx`
- Test: `tests/inspector-components.test.js` (append behavioral tests)

**Interfaces:**
- Consumes: `store.data`, `store.connected`, `store.loading`, `store.error`, `store.enrichment`, `store.live`; `culprit.*`; `index.loadEnrichment`, `index.runRevalidate`, `index.loadAnnotation`; reuse `JsonTree` from `src/audit/components/JsonTree.jsx` and `CopyBtn`/`fmtTime` from `src/audit/sources/auditLogs.jsx`.
- Produces: `App({ connected })` default export — renders not-connected message, else `IdInput` + (when `data`) Overview/Timeline/CulpritsSummary + tabbed panels. Each panel derives its view by calling `culprit.*` on `store.data.value`.

**Visual structure:** mirror `.superpowers/brainstorm/49593-1781795585/content/inspector-full.html` (rail is provided by the Console shell; this `App` renders only the right-hand content column: overview header, timeline, culprits summary, tab bar, panels, legend). Use `console.css` semantic vars; classes prefixed `.inspector-*`.

- [ ] **Step 1: Write the failing test (append)**

```js
import { h, render } from 'preact';
import App from '../src/inspector/components/App.jsx';
import * as store from '../src/inspector/store.js';

it('App shows a not-connected message when connected=false', () => {
  render(h(App, { connected: false }), root);
  expect(root.textContent).toMatch(/not connected|reconnect|Rossum/i);
});

it('App renders the culprit of a hook message once data is loaded', () => {
  store.setAnnotationId('5');
  store.data.value = {
    annotation: { id: 5, status: 'to_review', messages: [
      { type: 'error', content: 'HostNotFound', detail: { hook_id: 1791439, hook_name: 'Pre: Duplicate detector', is_exception: true } },
    ], automation_blocker: null },
    blocker: null, content: { content: [] },
    resolved: { queue: { automation_level: 'never' }, schema: null, usersById: {}, hooksById: {}, rulesById: {} },
  };
  render(h(App, { connected: true }), root);
  expect(root.textContent).toMatch(/Pre: Duplicate detector/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-components.test.js`
Expected: FAIL — `App.jsx` not found.

- [ ] **Step 3: Write minimal implementation**

Create each panel as a focused component. Representative core (`App.jsx`, `BlockedPanel.jsx`, `RejectedPanel.jsx`); `Overview`/`Timeline`/`CulpritsSummary`/`ProvenancePanel`/`ExportPanel` follow the same derive-from-`culprit` pattern and the mockup markup.

```jsx
// src/inspector/components/App.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { loadAnnotation } from '../index.jsx';
import IdInput from './IdInput.jsx';
import Overview from './Overview.jsx';
import Timeline from './Timeline.jsx';
import CulpritsSummary from './CulpritsSummary.jsx';
import BlockedPanel from './BlockedPanel.jsx';
import RejectedPanel from './RejectedPanel.jsx';
import ProvenancePanel from './ProvenancePanel.jsx';
import ExportPanel from './ExportPanel.jsx';

const TABS = [
  ['blocked', 'Why blocked'], ['rejected', 'Why rejected'],
  ['value', 'Field provenance'], ['export', 'Why export failed'],
];

export default function App({ connected }) {
  const [tab, setTab] = useState('blocked');
  if (connected === false) {
    return <div class="inspector-empty">Not connected. Open a Rossum annotation and click <b>Inspect this annotation</b>, or paste an id below.<div style="margin-top:12px"><IdInput onSubmit={(id) => { store.setAnnotationId(id); loadAnnotation(id); }} /></div></div>;
  }
  const d = store.data.value;
  return (
    <div class="inspector-root">
      <IdInput onSubmit={(id) => { store.setAnnotationId(id); loadAnnotation(id); }} />
      {store.loading.value && <div class="inspector-loading">Loading…</div>}
      {store.error.value && <div class="error-banner">{store.error.value}</div>}
      {d && (
        <div>
          <Overview />
          <Timeline />
          <CulpritsSummary />
          <div class="inspector-tabs">
            {TABS.map(([k, label]) => (
              <button class={`inspector-tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          {tab === 'blocked' && <BlockedPanel />}
          {tab === 'rejected' && <RejectedPanel />}
          {tab === 'value' && <ProvenancePanel />}
          {tab === 'export' && <ExportPanel />}
        </div>
      )}
    </div>
  );
}
```

```jsx
// src/inspector/components/BlockedPanel.jsx
import { h } from 'preact';
import * as store from '../store.js';
import { runRevalidate } from '../index.jsx';
import { classifyMessage, explainBlocker } from '../culprit.js';
import ReliabilityBadge from './ReliabilityBadge.jsx';

function CulpritChip({ culprit }) {
  if (!culprit) return <span class="inspector-culp inspector-culp-none">unattributed</span>;
  return <span class={`inspector-culp inspector-culp-${culprit.kind}`}><span class="cl">culprit</span> {culprit.name}{culprit.id != null ? ` #${culprit.id}` : ''}</span>;
}

export default function BlockedPanel() {
  const d = store.data.value; if (!d) return null;
  const ctx = { queue: d.resolved.queue, schemaById: {} };
  const blockers = (d.blocker?.content || []).map((b) => explainBlocker(b, ctx));
  const messages = (d.annotation.messages || []).map(classifyMessage);
  return (
    <div class="inspector-panel">
      <div class="inspector-sect">Automation blockers <ReliabilityBadge level="verified" /></div>
      {blockers.length === 0 && <div class="inspector-empty">No automation blockers.</div>}
      {blockers.map((b) => (
        <div class="inspector-bcard">
          <div><code>{b.type}</code>{b.schemaId ? <span> · {b.schemaId}</span> : null} <CulpritChip culprit={b.culprit} /> <ReliabilityBadge level={b.reliability} /></div>
          <div class="inspector-why">{b.explanation}</div>
        </div>
      ))}
      <div class="inspector-sect" style="margin-top:18px">Validation messages ({messages.length}) <ReliabilityBadge level="verified" /></div>
      {messages.map((m) => (
        <div class="inspector-mrow">
          <span class={`inspector-lv inspector-lv-${m.level}`}>{m.level}</span>
          <div><div class="inspector-mtxt">{m.content}</div>
            <div class="inspector-mrow2"><CulpritChip culprit={m.culprit} />{m.isException ? <span class="inspector-tag">is_exception</span> : null}{m.culprit == null ? <ReliabilityBadge level="unavailable" /> : null}</div></div>
        </div>
      ))}
      <div class="inspector-reeval">
        <span>Re-evaluate with current rules (live validate; brief reviewing lock).</span>
        <button class="btn btn-primary" onClick={() => runRevalidate()}>Re-evaluate</button>
      </div>
      {store.live.value && <div class="inspector-note">Live: {store.live.value.messages.length} message(s) from current config.</div>}
    </div>
  );
}
```

```jsx
// src/inspector/components/RejectedPanel.jsx
import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { loadEnrichment } from '../index.jsx';
import { classifyRejection, rankRejectCandidates } from '../culprit.js';
import ReliabilityBadge from './ReliabilityBadge.jsx';

export default function RejectedPanel() {
  const d = store.data.value; if (!d) return null;
  const [investigated, setInvestigated] = useState(false);
  const enr = store.enrichment.value;
  // ensure workflow + notes are loaded (best-effort)
  if (enr.workflow === null) loadEnrichment('workflow');
  if (enr.notes === null) loadEnrichment('notes');
  const rej = classifyRejection({
    annotation: d.annotation,
    workflowActivities: Array.isArray(enr.workflow) ? enr.workflow : [],
    notes: Array.isArray(enr.notes) ? enr.notes : [],
    usersById: d.resolved.usersById,
  });
  if (rej.type === 'none') return <div class="inspector-empty">This annotation has not been rejected.</div>;
  return (
    <div class="inspector-panel">
      <div class={`inspector-culprit inspector-culprit-${rej.culprit?.kind || 'none'}`}>
        <div class="lbl">Culprit · {rej.culprit?.kind}</div>
        <div class="name">{rej.culprit?.name} <ReliabilityBadge level={rej.reliability} /></div>
        <div class="meta">{rej.automatic ? 'Automatic' : 'Manual'} · {rej.when}</div>
      </div>
      <div class="inspector-reason"><div class="h">Reason</div><div class="body">{rej.reason.text || 'Reason not recorded by the API.'}</div> <ReliabilityBadge level={rej.reason.reliability} /></div>
      {rej.type === 'hook' && (
        <div class="inspector-detective">
          <button class="btn btn-primary" onClick={() => { loadEnrichment('hookLogs'); setInvestigated(true); }}>Investigate ▸</button>
          {investigated && Array.isArray(enr.hookLogs) && (
            <div class="inspector-candidates">
              {rankRejectCandidates({ hookLogs: enr.hookLogs, queueHooks: Object.values(d.resolved.hooksById || {}), rejectedAt: d.annotation.rejected_at, requestId: null }).map((c, i) => (
                <div class="inspector-crow"><span class="rank">{i + 1}</span><span class="nm">{c.name} #{c.hookId} · {c.capability}{c.matchedRequestId ? ' · request_id match' : ''}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

Create `Overview.jsx`, `Timeline.jsx`, `CulpritsSummary.jsx` (call `aggregateCulprits` over the derived messages/blockers/rejection), `ProvenancePanel.jsx` (map `d.content.content` datapoints through `fieldProvenance`, walking children for tables), `ExportPanel.jsx` (read `export_failed_at`/`status`, lazy `loadEnrichment('hookLogs')`), following the same derive-from-`culprit` + mockup-markup pattern. Each is presentational; no new logic beyond calling `culprit.*`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-components.test.js`
Expected: PASS (badge, IdInput, App not-connected, App culprit render).

- [ ] **Step 5: Commit**

```bash
git add src/inspector/components tests/inspector-components.test.js
git commit -m "feat(inspector): report panels + App shell"
```

---

## Task 10: Console shell wiring (4 switch-points + pending-annotation seed)

**Files:**
- Modify: `src/console/boot.js:5-7`; `src/console/components/Rail.jsx` (icon after :30, APPS :32-36); `src/console/components/Console.jsx:5-10,23-33`; `src/console/index.jsx` (imports ~18, TITLES ~24, inited flag ~45, ensureInited ~64, no-creds ~105, auth wiring ~121).
- Test: `tests/inspector-shell.test.js`

**Interfaces:**
- Consumes: `inspector/{api,store,index}` exports (`init`, `connected`/`domain`/`token`/`annotationId`, `initInspector`).
- Produces: `inspector` as a valid app, rail entry, render branch; the staged `pendingAnnotationId` is seeded into `inspectorStore.annotationId`.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isValidApp } from '../src/console/boot.js';
it('inspector is a valid console app', () => {
  expect(isValidApp('inspector')).toBe(true);
  expect(isValidApp('mdh')).toBe(true);
  expect(isValidApp('nope')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-shell.test.js`
Expected: FAIL — `isValidApp('inspector')` is `false`.

- [ ] **Step 3: Apply the exact edits**

`src/console/boot.js:5-7`:
```js
export function isValidApp(v) {
  return v === 'mdh' || v === 'audit' || v === 'galaxy' || v === 'inspector';
}
```

`src/console/index.jsx` — after the galaxy imports (~:18):
```jsx
import * as inspectorApi from '../inspector/api.js';
import * as inspectorStore from '../inspector/store.js';
import { initInspector } from '../inspector/index.jsx';
```
`TITLES` (~:24) add: `  inspector: 'Inspector — Rossum SA',`
Inited flag (~:45) add: `let inspectorInited = false;`
`ensureInited` (~:64) add before `return Promise.resolve();`:
```jsx
  if (app === 'inspector' && !inspectorInited) {
    inspectorInited = true;
    return initInspector();
  }
```
No-creds branch (~:105) add: `    inspectorStore.connected.value = false;`
Auth wiring (after galaxy block ~:121):
```jsx
  inspectorStore.domain.value = domain;
  inspectorStore.token.value = token;
  inspectorApi.init(domain, token);
  if (entry && entry.pendingAnnotationId) inspectorStore.annotationId.value = String(entry.pendingAnnotationId);
```
> If the staging object is bound to a different variable name than `entry` at this point, use whatever local holds the staged record (the same one `entry.app` was read from). Seed BEFORE `initInspector()` runs so the lazy init auto-loads.

`src/console/components/Console.jsx` imports (:5-10) add `InspectorApp` + `* as inspectorStore`; render switch (:23-33) add before the `else`:
```jsx
  } else if (app === 'inspector') {
    const c = inspectorStore.connected.value;
    view = c === null ? <Connecting /> : <InspectorApp connected={c} />;
```

`src/console/components/Rail.jsx` — icon after :30:
```jsx
const INSPECTOR_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
```
APPS array add: `  { id: 'inspector', label: 'Inspector', title: 'Annotation Inspector', icon: INSPECTOR_ICON, beta: true },`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-shell.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/console tests/inspector-shell.test.js
git commit -m "feat(inspector): wire inspector app into the Console shell"
```

---

## Task 11: Popup launcher — "Inspect this annotation"

**Files:**
- Modify: `src/popup/components/App.jsx` (import `readCurrentContext`; add `onInspectAnnotation`; add the button to the rossum tools-row ~:311). Reuse `runInTab` + `openConsoleTab` from `src/popup/utils.js`.
- Test: `tests/inspector-popup-launch.test.js`

**Interfaces:**
- Consumes: `runInTab(tab.id, readCurrentContext)`, `openConsoleTab(tab, authData, 'inspector')`.
- Produces: a button (gated `site==='rossum'`) that stages `{token, domain, pendingAnnotationId}` + opens the console at `inspector`.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';
vi.mock('../src/popup/utils.js', async (orig) => ({ ...(await orig()), runInTab: vi.fn(), openConsoleTab: vi.fn() }));
import * as utils from '../src/popup/utils.js';
import App from '../src/popup/components/App.jsx';

let root;
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); vi.clearAllMocks(); });
afterEach(() => { render(null, root); root.remove(); });

it('stages the current annotation id and opens the inspector app', async () => {
  utils.runInTab.mockResolvedValue({ token: 'T', domain: 'https://acme.rossum.app', annotationId: '133641827', queueId: '3' });
  render(h(App, { tab: { id: 1, url: 'https://acme.rossum.app/document/133641827', index: 0 } }), root);
  const btn = [...root.querySelectorAll('button')].find((b) => /inspect this annotation/i.test(b.textContent));
  expect(btn).toBeTruthy();
  btn.click();
  await Promise.resolve(); await Promise.resolve();
  expect(utils.openConsoleTab).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ token: 'T', domain: 'https://acme.rossum.app', pendingAnnotationId: '133641827' }), 'inspector');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inspector-popup-launch.test.js`
Expected: FAIL — no such button.

- [ ] **Step 3: Apply the edits**

In `src/popup/components/App.jsx`, extend the tab-readers import to include `readCurrentContext`, add the handler, and render the button in the rossum tools-row:
```jsx
const onInspectAnnotation = async () => {
  setAuthError(null);
  const ctx = await runInTab(tab.id, readCurrentContext);
  if (!ctx) return setAuthError({ kind: 'reload' });
  if (!ctx.token || !ctx.domain) return setAuthError({ kind: 'login' });
  if (!ctx.annotationId) return setAuthError({ kind: 'noAnnotation' });
  openConsoleTab(tab, { token: ctx.token, domain: ctx.domain, pendingAnnotationId: ctx.annotationId }, 'inspector');
};
```
```jsx
<button class="tool-btn" onClick={onInspectAnnotation}>
  <span>Inspect this annotation</span>
  <ExternalIconSmall />
</button>
```
Add a `noAnnotation` notice variant wherever `authError.kind` is rendered (copy: "Open a specific annotation first.").

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inspector-popup-launch.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/popup/components/App.jsx tests/inspector-popup-launch.test.js
git commit -m "feat(inspector): popup 'Inspect this annotation' launcher"
```

---

## Task 12: Styles + build + full-suite verification

**Files:**
- Modify: `src/console/console.css` (append an `.inspector-*` section near the end, after the app-rail section ~:2757).
- Verify: `build.js` needs no change (no new entry/copy line).

- [ ] **Step 1: Append `.inspector-*` rules driven by existing tokens**

Add styles for `.inspector-root`, `.inspector-empty`, `.inspector-idform/.inspector-idinput`, `.inspector-tabs/.inspector-tab`, `.inspector-panel`, `.inspector-sect`, `.inspector-bcard`, `.inspector-mrow/.inspector-mrow2/.inspector-mtxt`, `.inspector-lv-*`, `.inspector-culp/.inspector-culp-{hook,rule,engine,user,workflow,extension,queue,none}`, `.inspector-culprit*`, `.inspector-reason`, `.inspector-detective/.inspector-candidates/.inspector-crow`, `.inspector-rb/.inspector-rb-{verified,best-effort,unavailable}`, `.inspector-loading`, mirroring the approved mockup but using `var(--accent)`, `var(--success*)`, `var(--warning*)`, `var(--danger*)`, `var(--bg-*)`, `var(--text-*)`, `var(--border)`, `var(--radius)`, `var(--font-mono)` so dark mode works with no extra rules.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean build; `dist/console/console.js` produced.

- [ ] **Step 3: CSP-clean check**

Run: `grep -c "new Function" dist/console/console.js || true`
Expected: `0` (no codegen introduced).

- [ ] **Step 4: Full test suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new inspector suites green. (If any jsdom flakiness appears, use condition-based `waitFor`, never a bigger fixed sleep — per the de-flake convention.)

- [ ] **Step 5: Manual smoke (browser)**

Load `dist/` as an unpacked extension, open a Rossum annotation, click **Inspect this annotation** in the popup → Console opens on the Inspector pre-loaded with the id → verify the four tabs, the culprit chips, and the reliability badges render against live data.

- [ ] **Step 6: Commit**

```bash
git add src/console/console.css
git commit -m "feat(inspector): styles + final wiring"
```

---

## Self-review (run before handing off)

**Spec coverage:** §3.1 messages → Task 3; §3.2 blockers → Task 4; §3.3 rejection taxonomy → Task 5; §3.4 provenance + §6 detective/capability → Task 6; §3.6 two-tier (live revalidate) → Task 2 (`revalidate`) + Task 7 (`runRevalidate`); §4.1 placement → Task 10; §4.2 entry/auth → Task 11; §5 report UI (overview/timeline/culprits/panels) → Tasks 8–9; §7 reliability badges → Task 8 + threaded everywhere; §8 backward-compat variants → Tasks 3–5 tests; §9 testing → every task; CSS/build → Task 12.

**Placeholder scan:** Task 8 contains a deliberately-flagged stray `why` token in `IdInput.jsx` with a correction note — implementer must delete it. No other TODOs.

**Type consistency:** `culprit` object shape `{kind, id, name}` is consistent across `classifyMessage`/`explainBlocker`/`classifyRejection`/`aggregateCulprits`/`CulpritChip`. `REL` values (`verified`/`best-effort`/`unavailable`) match `ReliabilityBadge` class suffixes and CSS selectors. `store.data` shape `{annotation, blocker, content, resolved}` is produced in Task 7 and consumed identically in Tasks 8–9. `revalidate` returns the raw validate response; `runRevalidate` maps `matched_trigger_rules`→`matchedTriggerRules`.

**Known follow-ups (not blockers):** resolving hook/rule/user names into `resolved.hooksById`/`rulesById`/`usersById` is stubbed empty in Task 7 — add a `resolve.js` (60s LRU) lazily populating these from `getHook`/`getRule`/`getUser` as a refinement; until then names fall back to `#id`. The content-script `openConsoleApp` background path (spec §4.2) is intentionally out of scope for v1 (popup launch suffices).
