# API Call Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle Rossum API 429s honestly everywhere they can mislead (Inspector, Galaxy, popup), stop the Inspector listing hooks and rules several times per annotation, and stop the popup refetching data it can confirm with a tiny request.

**Architecture:** One shared module, `src/net/rateLimit.ts`, defines the 429 error every transport throws. The Inspector gets a per-load promise memo (`src/inspector/requestScope.ts`). The popup cache gains additive keys (`hadHooks`, `hookIds`, schema `sig`) and the panel confirms stale entries in the background with `GET /queues/X?fields=hooks` and `GET /schemas?queue=X`. Storage stays per surface.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly`), Preact + `@preact/signals`, esbuild, Vitest (jsdom/node environments), Prettier.

**Spec:** `docs/superpowers/specs/2026-10-13-api-call-reduction-design.md`

## Global Constraints

- Branch `api-call-hygiene` (from `master` at `d8b6e01`). One PR at the end. **Do not push or open the PR** — the owner does that.
- Never retry a 429 automatically. Retry happens only on a user action (Refresh, reopen, Retry button).
- Code that maps an error to "empty" must not do so for a 429.
- Refresh in the popup bypasses every cache and every check (existing `forceRefresh = refreshNonce > 0`).
- Cache keys stay additive: no prefix bump in `src/popup/cache.ts`; an entry written before this change behaves as today.
- No customer names, org hosts, hook names or dataset prefixes anywhere — fixtures use `acme` / `example` / `x` / `org` and `org.rossum.app` / `x.rossum.ai`.
- Tests run `src/`; run every test command with `NODE_OPTIONS=--no-experimental-webstorage` (Node 26).
- Test-first. After each new guard passes, mutation-check it: break the guard, confirm the test fails, restore.
- `tests/dead-code.test.ts` fails on an export nothing imports and on unused locals — do not export helpers only tests use, except `export type`.
- Do not annotate contextually typed callback parameters with `: any` (repo TypeScript rule).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A 429 on the popup's **schema** load must show the rate-limit message, not "No MDH matching on this queue." — test in Task 8.
2. A 429 on the popup's **annotation-values** load must show the message and must not be cached as empty values — test in Task 8.
3. A 429 that lands after the user moved to another Inspector annotation must not flag the new one — test in Task 4.
4. A popup background check that fails (429) must keep the cached view and must not trigger a refetch — test in Task 8.
5. A popup hook-cache entry written before this change (no `hadHooks`, no `hookIds`) must still be served inside 5 minutes and expire after — test in Task 7.

---

### Task 1: The shared 429 error

**Files:**
- Create: `src/net/rateLimit.ts`
- Test: `tests/net-rate-limit.test.ts`

**Interfaces:**
- Produces:
  - `type RateLimitError = Error & { status: 429; retryAfter: number | null }`
  - `rateLimitError(resp: { headers?: { get(name: string): string | null } | null }, message: string): RateLimitError`
  - `isRateLimited(err: unknown): err is RateLimitError`
  - `rateLimitMessage(err: { retryAfter?: number | null }): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/net-rate-limit.test.ts
import { describe, it, expect } from 'vitest';
import { isRateLimited, rateLimitError, rateLimitMessage } from '../src/net/rateLimit.js';

const resp = (retryAfter: string | null) => ({
  headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
});

describe('rateLimitError', () => {
  it('carries status 429, the message, and Retry-After in whole seconds', () => {
    const e = rateLimitError(resp('7'), 'Request was throttled.');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('Request was throttled.');
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(7);
  });

  it('reads retryAfter as null when the header is absent', () => {
    expect(rateLimitError(resp(null), 'x').retryAfter).toBeNull();
  });

  it('reads retryAfter as null for the HTTP-date form', () => {
    expect(rateLimitError(resp('Wed, 21 Oct 2026 07:28:00 GMT'), 'x').retryAfter).toBeNull();
  });

  it('reads retryAfter as null for a non-numeric value', () => {
    expect(rateLimitError(resp('soon'), 'x').retryAfter).toBeNull();
  });

  it('tolerates a response with no headers object (test doubles, odd transports)', () => {
    expect(rateLimitError({}, 'x').retryAfter).toBeNull();
  });
});

describe('isRateLimited', () => {
  it('is true for a rateLimitError and for any error with status 429', () => {
    expect(isRateLimited(rateLimitError(resp(null), 'x'))).toBe(true);
    expect(isRateLimited({ status: 429 })).toBe(true);
  });

  it('is false for other statuses and non-errors', () => {
    expect(isRateLimited({ status: 403 })).toBe(false);
    expect(isRateLimited(new Error('HTTP 500'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
    expect(isRateLimited('429')).toBe(false);
  });
});

describe('rateLimitMessage', () => {
  it('names the wait when Retry-After was given', () => {
    expect(rateLimitMessage({ retryAfter: 30 })).toBe(
      'Rossum is rate-limiting requests. Try again in 30 s.',
    );
  });

  it('says "shortly" when it was not', () => {
    expect(rateLimitMessage({ retryAfter: null })).toBe(
      'Rossum is rate-limiting requests. Try again shortly.',
    );
    expect(rateLimitMessage({})).toBe('Rossum is rate-limiting requests. Try again shortly.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/net-rate-limit.test.ts`
Expected: FAIL — cannot resolve `../src/net/rateLimit.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/net/rateLimit.ts
// The Rossum API's rate limit as ONE error shape that every transport throws
// (spec 2026-10-13-api-call-reduction-design.md §4.1). Nothing here retries: a
// 429 is shown to the user, who retries by acting (Refresh, reopen, Retry).

export type RateLimitError = Error & { status: 429; retryAfter: number | null };

type HeaderSource = { headers?: { get(name: string): string | null } | null };

// Retry-After is whole seconds or an HTTP-date; only the seconds form is read.
function retryAfterSeconds(value: string | null | undefined): number | null {
  if (value == null) return null;
  const v = value.trim();
  return /^\d+$/.test(v) ? Number(v) : null;
}

export function rateLimitError(resp: HeaderSource, message: string): RateLimitError {
  const e = new Error(message) as RateLimitError;
  e.status = 429;
  e.retryAfter = retryAfterSeconds(resp.headers?.get('Retry-After'));
  return e;
}

export function isRateLimited(err: unknown): err is RateLimitError {
  return (err as { status?: unknown } | null | undefined)?.status === 429;
}

export function rateLimitMessage(err: { retryAfter?: number | null }): string {
  return err.retryAfter != null
    ? `Rossum is rate-limiting requests. Try again in ${err.retryAfter} s.`
    : 'Rossum is rate-limiting requests. Try again shortly.';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/net-rate-limit.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

The module is not imported by `src/` yet, so `tests/dead-code.test.ts` would flag it — commit it together with Task 2, not alone. Go straight to Task 2.

---

### Task 2: Every transport in scope throws the 429 error

**Files:**
- Modify: `src/inspector/api.ts` (inside `get`, the `if (!res.ok)` block)
- Modify: `src/galaxy/api.ts` (inside `get`, the `if (!res.ok)` block)
- Modify: `src/popup/mdh-provenance.ts:10-16` (`fetchJson`)
- Test: `tests/net-transports-429.test.ts`

**Interfaces:**
- Consumes: `rateLimitError` from Task 1.
- Produces: `inspector/api.get`, `galaxy/api.get` and popup `fetchJson` reject a 429 with a `RateLimitError` (message = the response's `detail`, else `API error 429` / `HTTP 429`). Popup `fetchJson` errors also carry `status` for every non-OK response (message unchanged: `HTTP <status>`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/net-transports-429.test.ts
// @vitest-environment jsdom
// Spec 2026-10-13-api-call-reduction-design.md §4.1: one 429 shape from every transport.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as inspectorApi from '../src/inspector/api.js';
import * as galaxyApi from '../src/galaxy/api.js';
import { fetchJson } from '../src/popup/mdh-provenance.js';

const throttled = (retryAfter: string | null) => ({
  ok: false,
  status: 429,
  headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
  json: async () => ({ detail: 'Request was throttled.' }),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a 429 from each transport', () => {
  it('inspector get rejects with status 429, retryAfter and the server detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => throttled('12')));
    inspectorApi.init('https://x.rossum.ai', 't');
    await expect(inspectorApi.get('/api/v1/hooks')).rejects.toMatchObject({
      status: 429,
      retryAfter: 12,
      message: 'Request was throttled.',
    });
  });

  it('inspector safeListAll does not swallow a 429 into []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => throttled(null)));
    inspectorApi.init('https://x.rossum.ai', 't');
    await expect(inspectorApi.safeListAll('/api/v1/hooks')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('galaxy get rejects with status 429 and retryAfter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => throttled('4')));
    galaxyApi.init('https://x.rossum.ai', 't');
    await expect(galaxyApi.get('/api/v1/hooks/')).rejects.toMatchObject({
      status: 429,
      retryAfter: 4,
    });
  });

  it('popup fetchJson rejects with status 429 and retryAfter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => throttled(null)));
    await expect(fetchJson('https://x.rossum.ai/api/v1/hooks', 't')).rejects.toMatchObject({
      status: 429,
      retryAfter: null,
    });
  });

  it('popup fetchJson keeps its message and now carries status on other errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(fetchJson('https://x.rossum.ai/api/v1/hooks', 't')).rejects.toMatchObject({
      status: 500,
      message: 'HTTP 500',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/net-transports-429.test.ts`
Expected: FAIL — the 429 tests get `status: 429` but no `retryAfter` (Inspector/Galaxy) or no `status` at all (popup).

- [ ] **Step 3: Implement**

In `src/inspector/api.ts`, add the import under the header comment:

```ts
import { rateLimitError } from '../net/rateLimit.js';
```

and in `get`, make the first statement inside `if (!res.ok) {` the 429 branch:

```ts
  if (!res.ok) {
    if (res.status === 429) throw rateLimitError(res, data?.detail || 'API error 429');
    const err = apiError(data?.detail || data?.message || `API error ${res.status}`, res.status);
```

Make the identical two edits in `src/galaxy/api.ts` (import under the header comment; same first line inside `if (!res.ok) {`).

In `src/popup/mdh-provenance.ts`, add `import { rateLimitError } from '../net/rateLimit.js';` with the other imports at the top, and replace `fetchJson`:

```ts
export async function fetchJson(url: string, token: string): Promise<any> {
  const resp = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  if (resp.status === 429) throw rateLimitError(resp, 'HTTP 429');
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  return resp.json();
}
```

- [ ] **Step 4: Run the new tests and the transports' existing suites**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/net-rate-limit.test.ts tests/net-transports-429.test.ts tests/inspector-api.test.ts tests/galaxy-api.test.ts tests/mdh-provenance.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Delete the `if (res.status === 429) …` line in `src/galaxy/api.ts`; the galaxy test must fail on `retryAfter`. Restore. Repeat for `src/inspector/api.ts` and the popup `fetchJson` 429 line.

- [ ] **Step 6: Commit**

```bash
git add src/net/rateLimit.ts tests/net-rate-limit.test.ts src/inspector/api.ts src/galaxy/api.ts src/popup/mdh-provenance.ts tests/net-transports-429.test.ts
git commit -m "feat(net): one 429 error shape for the Inspector, Galaxy and popup transports

Each transport threw a 429 as a generic error, so no caller could tell
rate limiting apart from a broken request.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Inspector lists hooks, rules and labels once per annotation

**Files:**
- Create: `src/inspector/requestScope.ts`
- Modify: `src/inspector/index.tsx` (top-level state; `loadAnnotation`; `closeAnnotation`; `loadQueueHooks`; `loadLabelContext`; `loadQueueRules`; the `orchestrateAttributions` call)
- Test: `tests/inspector-request-scope.test.ts`, `tests/inspector-dedupe.test.ts`

**Interfaces:**
- Produces:
  - `type RequestScope = { get<T>(key: string, fn: () => Promise<T>): Promise<T> }`
  - `createRequestScope(): RequestScope` — memoises every promise, fulfilled or rejected, for the scope's life.
  - In `index.tsx` (module-private): `listHooksOnce(queueId: string)`, `listRulesOnce(queueId: string)`, `listLabelsOnce()`, and `scope`, replaced on every new load and on `closeAnnotation`.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/inspector-request-scope.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createRequestScope } from '../src/inspector/requestScope.js';

describe('createRequestScope', () => {
  it('shares one run between concurrent callers of a key', async () => {
    const scope = createRequestScope();
    const fn = vi.fn(async () => [1]);
    const [a, b] = await Promise.all([scope.get('hooks:3', fn), scope.get('hooks:3', fn)]);
    expect(a).toEqual([1]);
    expect(b).toBe(a);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reuses a settled success for a later caller', async () => {
    const scope = createRequestScope();
    const fn = vi.fn(async () => 'v');
    await scope.get('k', fn);
    await scope.get('k', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reuses a failure too, so nobody in the load retries it', async () => {
    const scope = createRequestScope();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('throttled'), { status: 429 });
    });
    await expect(scope.get('k', fn)).rejects.toMatchObject({ status: 429 });
    await expect(scope.get('k', fn)).rejects.toMatchObject({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs different keys separately, and separate scopes never share', async () => {
    const one = createRequestScope();
    const two = createRequestScope();
    const fn = vi.fn(async () => 'v');
    await one.get('a', fn);
    await one.get('b', fn);
    await two.get('a', fn);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/inspector-request-scope.test.ts`
Expected: FAIL — cannot resolve `requestScope.js`.

- [ ] **Step 3: Implement the scope**

```ts
// src/inspector/requestScope.ts
// A promise memo for ONE annotation load (spec 2026-10-13-api-call-reduction-design.md
// §4.2). Every caller in the load shares one request per key: the loaders, the panels
// that call them on mount, and the attribution fallback. A rejection is kept too, so
// nobody in the load retries it, a 429 included. The next load creates a new scope,
// which is what makes reopening an annotation fetch again.
export type RequestScope = { get<T>(key: string, fn: () => Promise<T>): Promise<T> };

export function createRequestScope(): RequestScope {
  const memo = new Map<string, Promise<unknown>>();
  return {
    get<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let p = memo.get(key) as Promise<T> | undefined;
      if (!p) {
        p = fn();
        // Kept even when rejected; mark it handled so a caller that never awaits it
        // does not surface an unhandled rejection.
        p.catch(() => {});
        memo.set(key, p);
      }
      return p;
    },
  };
}
```

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/inspector-request-scope.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing load-level test**

```ts
// tests/inspector-dedupe.test.ts
// @vitest-environment node
// Spec 2026-10-13-api-call-reduction-design.md §4.2: one list per annotation load.
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/inspector/api.js');
vi.mock('../src/inspector/orchestrate.js', () => ({
  orchestrateAttributions: vi.fn(async () => {}),
}));
vi.mock('../src/agent/agentApi.js', () => ({
  init: vi.fn(),
  probeAgent: vi.fn(() => Promise.resolve(false)),
}));
import * as api from '../src/inspector/api.js';
import * as store from '../src/inspector/store.js';
import { orchestrateAttributions } from '../src/inspector/orchestrate.js';
import { loadAnnotation, loadLabelContext, loadQueueHooks } from '../src/inspector/index.jsx';

const ANN = { id: 5, status: 'to_review', messages: [], queue: 'https://h/api/v1/queues/3' };

async function openAnnotation(id = '5') {
  store.setAnnotationId(id);
  await loadAnnotation(id);
}
// The investigation ends at agent-offline: the agent probe is mocked to false.
const settled = () =>
  vi.waitFor(() => expect(store.investigation.value.stage).toBe('agent-offline'));

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  vi.mocked(api.getAnnotation).mockResolvedValue(ANN);
  vi.mocked(api.getContent).mockResolvedValue({ content: [] });
  vi.mocked(api.getQueue).mockResolvedValue({ id: 3 });
  vi.mocked(api.listHooks).mockResolvedValue([{ id: 1, name: 'H', active: true }]);
  vi.mocked(api.listRules).mockResolvedValue([]);
  vi.mocked(api.listLabels).mockResolvedValue([]);
});

describe('Inspector request scope', () => {
  it('lists hooks, rules and labels once, even with panels calling the loaders mid-load', async () => {
    await openAnnotation();
    // What PipelinePanel, ProvenancePanel, ExportPanel and LabelsPanel do on mount:
    loadQueueHooks();
    loadQueueHooks();
    loadLabelContext();
    await settled();
    expect(api.listHooks).toHaveBeenCalledTimes(1);
    expect(api.listRules).toHaveBeenCalledTimes(1);
    expect(api.listLabels).toHaveBeenCalledTimes(1);
  });

  it("hands the attribution fallback the load's hooks list instead of a new request", async () => {
    vi.mocked(api.listHooks).mockResolvedValue([]); // no hooks → the fallback would fire
    vi.mocked(orchestrateAttributions).mockImplementationOnce((async (opts: any) => {
      await opts.api.listHooks('3');
    }) as any);
    await openAnnotation();
    await settled();
    expect(api.listHooks).toHaveBeenCalledTimes(1);
  });

  it('a new annotation load lists again', async () => {
    await openAnnotation('5');
    await settled();
    await openAnnotation('6');
    await settled();
    expect(api.listHooks).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/inspector-dedupe.test.ts`
Expected: FAIL — the first test sees `listHooks` called 3 or more times; the second sees 2.

- [ ] **Step 6: Wire the scope into `src/inspector/index.tsx`**

Add the import after `import { runSynthesis, continueSynthesis } from './synthesize.js';`:

```ts
import { createRequestScope } from './requestScope.js';
```

Below `let loadId = 0;` add:

```ts
// One request per list per annotation load (spec 2026-10-13 §4.2); replaced with loadId.
let scope = createRequestScope();
const listHooksOnce = (queueId: string) =>
  scope.get(`hooks:${queueId}`, () => api.listHooks(queueId));
const listRulesOnce = (queueId: string) =>
  scope.get(`rules:${queueId}`, () => api.listRules(queueId));
const listLabelsOnce = () => scope.get('labels', () => api.listLabels());
```

In `loadAnnotation`, directly after `const myId = ++loadId;`:

```ts
  scope = createRequestScope();
```

In `closeAnnotation`, directly after `loadId++;`:

```ts
  scope = createRequestScope();
```

In `loadQueueHooks`, replace `api.listHooks(idFromUrl(d.annotation.queue) as string)` with `listHooksOnce(idFromUrl(d.annotation.queue) as string)`.

In `loadQueueRules`, replace `api.listRules(idFromUrl(d.annotation.queue) as string)` with `listRulesOnce(idFromUrl(d.annotation.queue) as string)`.

In `loadLabelContext`, replace the three list calls:

```ts
  const [labels, rules, hooks] = await Promise.all([
    safe(() => listLabelsOnce()),
    queueId ? safe(() => listRulesOnce(queueId)) : Promise.resolve(null),
    queueId ? safe(() => listHooksOnce(queueId)) : Promise.resolve(null),
  ]);
```

In `prefetchAndOrchestrate`, replace `await orchestrateAttributions({ store, api, agentApi, signal });` with:

```ts
  // The attribution fallback lists hooks too (attributionContext.ts): give it the load's list.
  const scopedApi = { ...api, listHooks: (queueId: string) => listHooksOnce(String(queueId)) };
  await orchestrateAttributions({ store, api: scopedApi, agentApi, signal });
```

- [ ] **Step 7: Run the Inspector suites**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/inspector-request-scope.test.ts tests/inspector-dedupe.test.ts tests/inspector-index.test.ts tests/inspector-orchestrate.test.ts tests/inspector-attribution-context.test.ts`
Expected: PASS.

- [ ] **Step 8: Mutation-check**

Replace the body of `listHooksOnce` with `api.listHooks(queueId)` (no scope); the first two dedupe tests must fail. Restore. Delete `scope = createRequestScope();` from `loadAnnotation`; the "new load lists again" test must fail. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/inspector/requestScope.ts src/inspector/index.tsx tests/inspector-request-scope.test.ts tests/inspector-dedupe.test.ts
git commit -m "perf(inspector): list hooks, rules and labels once per annotation

Three loaders, four panels and the attribution fallback each listed them,
so one annotation sent the queue's full hooks list several times.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Inspector says "rate-limited" instead of "no hooks"

**Files:**
- Modify: `src/inspector/store.ts` (new signal; reset in `setAnnotationId` and `reset`)
- Modify: `src/inspector/index.tsx` (`safe`; `loadQueueHooks`; `loadQueueRules`; `loadLabelContext`)
- Modify: `src/inspector/components/Report.tsx` (notice under `<InvestigationStrip />`)
- Modify: `src/console/console.css` (one rule after the `.inspector-lv-info` rule)
- Test: `tests/inspector-rate-limit.test.ts`, `tests/inspector-report.test.tsx` (append)

**Interfaces:**
- Consumes: `isRateLimited`, `rateLimitMessage` (Task 1); `listHooksOnce` etc. (Task 3).
- Produces: `store.rateLimited: Signal<{ retryAfter: number | null } | null>` — set when a request of the CURRENT load got a 429; cleared on every annotation change.

- [ ] **Step 1: Write the failing load-level test**

```ts
// tests/inspector-rate-limit.test.ts
// @vitest-environment node
// Spec 2026-10-13-api-call-reduction-design.md §4.2: a 429 is not "no hooks".
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/inspector/api.js');
vi.mock('../src/inspector/orchestrate.js', () => ({
  orchestrateAttributions: vi.fn(async () => {}),
}));
vi.mock('../src/agent/agentApi.js', () => ({
  init: vi.fn(),
  probeAgent: vi.fn(() => Promise.resolve(false)),
}));
import * as api from '../src/inspector/api.js';
import * as store from '../src/inspector/store.js';
import { loadAnnotation } from '../src/inspector/index.jsx';

const ANN = { id: 5, status: 'to_review', messages: [], queue: 'https://h/api/v1/queues/3' };
const throttled = (retryAfter: number | null) =>
  Object.assign(new Error('Request was throttled.'), { status: 429, retryAfter });

async function openAnnotation(id = '5') {
  store.setAnnotationId(id);
  await loadAnnotation(id);
}
const settled = () =>
  vi.waitFor(() => expect(store.investigation.value.stage).toBe('agent-offline'));

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  vi.mocked(api.getAnnotation).mockResolvedValue(ANN);
  vi.mocked(api.getContent).mockResolvedValue({ content: [] });
  vi.mocked(api.getQueue).mockResolvedValue({ id: 3 });
  vi.mocked(api.listHooks).mockResolvedValue([{ id: 1, name: 'H', active: true }]);
  vi.mocked(api.listRules).mockResolvedValue([]);
  vi.mocked(api.listLabels).mockResolvedValue([]);
});

describe('Inspector under a 429', () => {
  it('records the 429 and leaves hooks unloaded instead of empty', async () => {
    vi.mocked(api.listHooks).mockRejectedValue(throttled(9));
    await openAnnotation();
    await settled();
    expect(store.rateLimited.value).toEqual({ retryAfter: 9 });
    expect(store.data.value.resolved._hooksLoaded).not.toBe(true);
    // loadLabelContext lists hooks too; it must not write a half-empty label context.
    expect(store.data.value.resolved.labelsById).toBeUndefined();
    expect(api.listHooks).toHaveBeenCalledTimes(1); // no automatic retry within the load
  });

  it('leaves rules unloaded on a 429', async () => {
    vi.mocked(api.listRules).mockRejectedValue(throttled(null));
    await openAnnotation();
    await settled();
    expect(store.rateLimited.value).toEqual({ retryAfter: null });
    expect(store.data.value.resolved._rulesLoaded).not.toBe(true);
  });

  it('keeps today’s behaviour for a non-429 failure', async () => {
    vi.mocked(api.listHooks).mockRejectedValue(
      Object.assign(new Error('API error 500'), { status: 500 }),
    );
    await openAnnotation();
    await settled();
    expect(store.rateLimited.value).toBeNull();
    expect(store.data.value.resolved._hooksLoaded).toBe(true);
  });

  it('a 429 that lands after the user moved on does not flag the new annotation', async () => {
    vi.mocked(api.listHooks).mockImplementationOnce(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(throttled(5)), 30)),
    );
    await openAnnotation('5');
    await openAnnotation('6');
    await settled();
    await new Promise((r) => setTimeout(r, 50)); // let the old 429 arrive
    expect(store.rateLimited.value).toBeNull();
  });

  it('opening another annotation clears the flag', async () => {
    vi.mocked(api.listHooks).mockRejectedValueOnce(throttled(9));
    await openAnnotation('5');
    await settled();
    expect(store.rateLimited.value).not.toBeNull();
    store.setAnnotationId('6');
    expect(store.rateLimited.value).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/inspector-rate-limit.test.ts`
Expected: FAIL — `store.rateLimited` is undefined.

- [ ] **Step 3: Add the signal to `src/inspector/store.ts`**

After `export const error = signal<string | null>(null);`:

```ts
// Set when a request of the CURRENT annotation load got a 429 (spec 2026-10-13 §4.2).
export const rateLimited = signal<{ retryAfter: number | null } | null>(null);
```

In both `setAnnotationId` and `reset`, next to `error.value = null;`, add:

```ts
  rateLimited.value = null;
```

- [ ] **Step 4: Record 429s and stop treating them as empty in `src/inspector/index.tsx`**

Add `import { isRateLimited } from '../net/rateLimit.js';` after the `./requestScope.js` import. Replace `safe`:

```ts
// Best-effort: any failure reads as null. A 429 is also recorded on the load it belongs
// to, so the report says "rate-limited" instead of reading missing lists as empty.
const safe = (fn: any) => {
  const myId = loadId;
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (isRateLimited(err) && myId === loadId)
        store.rateLimited.value = { retryAfter: err.retryAfter };
      return null;
    });
};
```

Replace the body of `loadQueueHooks` after `const myId = loadId;`:

```ts
  const hooks = await safe(() => listHooksOnce(idFromUrl(d.annotation.queue) as string));
  const cur = store.data.value;
  if (!cur || myId !== loadId) return; // superseded by a newer annotation → don't contaminate it
  // Rate-limited is not "this queue has no hooks": leave them unloaded (spec 2026-10-13 §4.2).
  if (hooks === null && store.rateLimited.value) return;
  const hooksById: Record<string, any> = {};
  for (const hk of (hooks || []) as any[]) hooksById[hk.id] = hk;
  store.data.value = { ...cur, resolved: { ...cur.resolved, hooksById, _hooksLoaded: true } };
```

Replace the body of `loadQueueRules` after `const myId = loadId;`:

```ts
  const rules = await safe(() => listRulesOnce(idFromUrl(d.annotation.queue) as string));
  const cur = store.data.value;
  if (!cur || myId !== loadId) return; // superseded → skip stale write
  if (rules === null && store.rateLimited.value) return; // rate-limited, not "no rules"
  store.data.value = {
    ...cur,
    resolved: { ...cur.resolved, rules: rules || [], _rulesLoaded: true },
  };
```

In `loadLabelContext`, directly after `if (!cur || myId !== loadId) return; // superseded → …` add:

```ts
  const failed = labels === null || (!!queueId && (rules === null || hooks === null));
  if (failed && store.rateLimited.value) return; // rate-limited: no half-empty label context
```

- [ ] **Step 5: Run the load-level tests**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/inspector-rate-limit.test.ts tests/inspector-dedupe.test.ts tests/inspector-index.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing report test** — append to `tests/inspector-report.test.tsx` inside `describe('Report', …)`:

```tsx
  it('shows one rate-limit notice when the load was rate-limited', () => {
    store.data.value = baseAnnotation();
    store.rateLimited.value = { retryAfter: 20 };
    const el = mount();
    expect(el.querySelector('.inspector-ratelimit')!.textContent).toContain(
      'Rossum is rate-limiting requests. Try again in 20 s.',
    );
    store.rateLimited.value = null;
  });

  it('shows no notice otherwise', () => {
    store.data.value = baseAnnotation();
    store.rateLimited.value = null;
    expect(mount().querySelector('.inspector-ratelimit')).toBeNull();
  });
```

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/inspector-report.test.tsx`
Expected: FAIL — no `.inspector-ratelimit`.

- [ ] **Step 7: Render the notice and style it**

In `src/inspector/components/Report.tsx` add `import { rateLimitMessage } from '../../net/rateLimit.js';` after the `store` import, and directly after `<InvestigationStrip />`:

```tsx
      {store.rateLimited.value && (
        <div class="inspector-ratelimit" role="status">
          Some data could not be loaded. {rateLimitMessage(store.rateLimited.value)} Reopen the
          annotation to load it again.
        </div>
      )}
```

In `src/console/console.css`, after the `.inspector-lv-info { … }` rule:

```css
.inspector-ratelimit {
  margin: 8px 0;
  padding: 8px 12px;
  border: 1px solid var(--warning-border);
  border-radius: 6px;
  background: var(--warning-bg);
  color: var(--warning-fg);
  font-size: 12px;
}
```

- [ ] **Step 8: Run the Inspector suites**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/inspector-rate-limit.test.ts tests/inspector-report.test.tsx tests/inspector-index.test.ts tests/inspector-store.test.ts`
Expected: PASS.

- [ ] **Step 9: Mutation-check**

Remove `&& myId === loadId` from `safe`; the "lands after the user moved on" test must fail. Restore. Remove the `if (hooks === null && store.rateLimited.value) return;` line; the first test must fail. Restore.

- [ ] **Step 10: Commit**

```bash
git add src/inspector/store.ts src/inspector/index.tsx src/inspector/components/Report.tsx src/console/console.css tests/inspector-rate-limit.test.ts tests/inspector-report.test.tsx
git commit -m "fix(inspector): say rate-limited instead of reading a 429 as no hooks

safe() turned every error into null and the loaders read null as an empty
list, so a throttled hooks list produced a confident wrong diagnosis.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Galaxy stops paging after a 429 and offers Retry

**Files:**
- Modify: `src/galaxy/api.ts` (`fetchOrgResources`)
- Modify: `src/galaxy/store.ts` (new `retryable` signal)
- Modify: `src/galaxy/index.tsx` (`loadGraph`)
- Modify: `src/galaxy/components/App.tsx` (error overlay)
- Test: `tests/galaxy-api.test.ts`, `tests/galaxy-init.test.ts`, `tests/galaxy-app.test.tsx` (append to each)

**Interfaces:**
- Consumes: `isRateLimited`, `rateLimitMessage` (Task 1); galaxy `get` throws the 429 error (Task 2).
- Produces: `store.retryable: Signal<boolean>`; `loadGraph()` clears `error` and `retryable` when it starts.

- [ ] **Step 1: Write the failing API test** — append inside `describe('fetchOrgResources', …)` in `tests/galaxy-api.test.ts`:

```ts
  it('a 429 on one collection stops the others from paging any further', async () => {
    const requested: string[] = [];
    fetchMock.mockImplementation(async (url: string, opts: any) => {
      if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      requested.push(url);
      if (url.includes('/hooks/'))
        return {
          ok: false,
          status: 429,
          headers: { get: () => '5' },
          json: () => Promise.resolve({}),
        };
      if (url.includes('/workspaces/?')) {
        await new Promise((r) => setTimeout(r, 20));
        return jsonRes({
          results: [{ id: 1 }],
          pagination: { next: 'https://x.rossum.ai/api/v1/workspaces/?page=2' },
        });
      }
      return jsonRes({ results: [] });
    });
    await expect(api.fetchOrgResources()).rejects.toMatchObject({ status: 429, retryAfter: 5 });
    await new Promise((r) => setTimeout(r, 40));
    expect(requested.some((u) => u.includes('page=2'))).toBe(false);
  });
```

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/galaxy-api.test.ts`
Expected: FAIL — `page=2` was requested.

- [ ] **Step 2: Abort sibling lists in `src/galaxy/api.ts`**

Replace the `Promise.all([...])` call in `fetchOrgResources` with:

```ts
  // The first failure stops every sibling list (spec 2026-10-13 §4.3): after a 429 the
  // other four would otherwise keep paging into the same limit. A 403/404 is not a
  // failure here — safeListAll degrades it to [].
  const stop = new AbortController();
  const listSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const list = (path: string) =>
    safeListAll(path, { signal: listSignal, onPage }).catch((err) => {
      stop.abort();
      throw err;
    });
  const [orgs, workspaces, queues, hooks, engines] = await Promise.all([
    list(`/api/v1/organizations/?${q}`),
    list(`/api/v1/workspaces/?${q}`),
    list(`/api/v1/queues/?${q}`),
    list(`/api/v1/hooks/?${q}`),
    list(`/api/v1/engines/?${q}`),
  ]);
```

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/galaxy-api.test.ts`
Expected: PASS, including the existing 403 and 401 tests.

- [ ] **Step 3: Write the failing init test** — in `tests/galaxy-init.test.ts`, change the import to `import { initGalaxy, loadGraph } from '../src/galaxy/index.jsx';`, add `store.retryable.value = false;` to `beforeEach`, and append inside `describe('initGalaxy', …)`:

```ts
  it('a 429 shows the rate-limit message and offers Retry; Retry loads again', async () => {
    apiMock.whoami.mockResolvedValue({ id: 1 });
    apiMock.fetchOrgResources.mockRejectedValueOnce(
      Object.assign(new Error('Request was throttled.'), { status: 429, retryAfter: 30 }),
    );
    await initGalaxy();
    await vi.waitFor(() => {
      expect(store.error.value).toBe('Rossum is rate-limiting requests. Try again in 30 s.');
    });
    expect(store.retryable.value).toBe(true);
    apiMock.fetchOrgResources.mockResolvedValueOnce({
      organization: null,
      workspaces: [],
      queues: [],
      hooks: [],
      engines: [],
    });
    await loadGraph();
    expect(store.error.value).toBeNull();
    expect(store.retryable.value).toBe(false);
    expect(apiMock.fetchOrgResources).toHaveBeenCalledTimes(2);
  });

  it('other errors are not retryable', async () => {
    apiMock.whoami.mockResolvedValue({ id: 1 });
    apiMock.fetchOrgResources.mockRejectedValue(new Error('boom'));
    await initGalaxy();
    await vi.waitFor(() => expect(store.error.value).toMatch(/boom/));
    expect(store.retryable.value).toBe(false);
  });
```

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/galaxy-init.test.ts`
Expected: FAIL — `store.retryable` is undefined.

- [ ] **Step 4: Implement the store flag and `loadGraph`**

In `src/galaxy/store.ts`, after `export const error = signal<string | null>(null);`:

```ts
export const retryable = signal(false); // the last load failed in a way Retry can fix (a 429)
```

In `src/galaxy/index.tsx` add `import { isRateLimited, rateLimitMessage } from '../net/rateLimit.js';` and replace `loadGraph`:

```ts
export async function loadGraph() {
  store.loading.value = true;
  store.loadedCount.value = 0;
  store.error.value = null;
  store.retryable.value = false;
  try {
    const raw = await api.fetchOrgResources({
      onProgress: (n) => {
        store.loadedCount.value = n;
      },
    });
    store.graph.value = buildGraph(raw);
  } catch (err: any) {
    if (isRateLimited(err)) {
      store.error.value = rateLimitMessage(err);
      store.retryable.value = true; // never retried automatically (spec 2026-10-13 §4.3)
    } else {
      store.error.value = err.message || 'Failed to load the organization';
    }
  } finally {
    store.loading.value = false;
  }
}
```

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/galaxy-init.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing App test** — in `tests/galaxy-app.test.tsx` add `store.retryable.value = false;` to `beforeEach` and append inside `describe('Galaxy App', …)`:

```tsx
  it('shows a Retry button for a retryable error', () => {
    store.error.value = 'Rossum is rate-limiting requests. Try again shortly.';
    store.retryable.value = true;
    const root = mount(true);
    expect(root.querySelector('.galaxy-error button')!.textContent).toBe('Retry');
  });

  it('shows no Retry button for other errors', () => {
    store.error.value = 'Boom';
    const root = mount(true);
    expect(root.querySelector('.galaxy-error button')).toBeNull();
  });
```

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/galaxy-app.test.tsx`
Expected: FAIL — no button.

- [ ] **Step 6: Render the button in `src/galaxy/components/App.tsx`**

Add `retryable` to the `../store.js` import list, add `import { loadGraph } from '../index.jsx';`, and replace the error line:

```tsx
        {error.value && (
          <div class="galaxy-error">
            <span>{error.value}</span>
            {retryable.value && (
              <button type="button" class="btn" onClick={() => loadGraph()}>
                Retry
              </button>
            )}
          </div>
        )}
```

- [ ] **Step 7: Run all Galaxy suites**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/galaxy-api.test.ts tests/galaxy-init.test.ts tests/galaxy-app.test.tsx`
Expected: PASS.

- [ ] **Step 8: Mutation-check**

Remove `stop.abort();` from the `.catch` in `fetchOrgResources`; the abort test must fail. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/galaxy/api.ts src/galaxy/store.ts src/galaxy/index.tsx src/galaxy/components/App.tsx tests/galaxy-api.test.ts tests/galaxy-init.test.ts tests/galaxy-app.test.tsx
git commit -m "fix(galaxy): stop every list on the first 429 and offer Retry

The other four collections kept paging after a 429, sending more requests
into the same rate limit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Popup fetch helpers for cheap checks

**Files:**
- Modify: `src/popup/mdh-provenance.ts` (`QueueSchemaInfo`; `fetchQueueSchemaContent` → `fetchQueueSchema`; `loadSchemaForQueue`; `resolveLookupVariables`; `loadMdhHooksForQueue`; new `schemaSig`, `fetchSchemaSig`, `fetchQueueHookIds`, `sameIds`)
- Test: `tests/popup-revalidate-fetch.test.ts`

**Interfaces:**
- Consumes: `isRateLimited` (Task 1); `fetchJson` (Task 2).
- Produces:
  - `QueueSchemaInfo` gains `sig?: string`.
  - `loadSchemaForQueue(domain, token, queueId): Promise<QueueSchemaInfo>` — requests the schema with `?fields=content,id,modified_at`, sets `sig` when id and modified_at are present, rethrows a 429 (other errors still return the empty info).
  - `loadMdhHooksForQueue(domain, token, queueId, onAttached?: (hookIds: string[]) => void): Promise<any[]>` — unchanged return; `onAttached` receives the ids of every hook the list returned.
  - `fetchQueueHookIds(domain, token, queueId): Promise<string[]>` — `GET /queues/{id}?fields=hooks`.
  - `fetchSchemaSig(domain, token, queueId): Promise<string | null>` — `GET /schemas?queue={id}`. (`schemaSig` stays module-private: `tests/dead-code.test.ts` fails on an export only tests use.)
  - `sameIds(a: string[], b: string[]): boolean` — order-insensitive.
  - Signature format: `` `${id}:${modified_at}` ``.

- [ ] **Step 1: Write the failing test**

```ts
// tests/popup-revalidate-fetch.test.ts
// Spec 2026-10-13-api-call-reduction-design.md §4.4: the popup's cheap checks.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchQueueHookIds,
  fetchSchemaSig,
  loadMdhHooksForQueue,
  loadSchemaForQueue,
  sameIds,
} from '../src/popup/mdh-provenance.js';

const D = 'https://x.rossum.app';
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const throttled = { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchQueueHookIds', () => {
  it("reads the queue's attached hooks as ids from ?fields=hooks", async () => {
    const fetchMock = vi.fn(async () =>
      ok({ hooks: [`${D}/api/v1/hooks/12`, `${D}/api/v1/hooks/7/`] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchQueueHookIds(D, 't', 42)).toEqual(['12', '7']);
    expect(fetchMock.mock.calls[0]).toEqual([
      `${D}/api/v1/queues/42?fields=hooks`,
      expect.anything(),
    ]);
  });

  it('returns [] for a queue with no hooks field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({})));
    expect(await fetchQueueHookIds(D, 't', 42)).toEqual([]);
  });
});

describe('fetchSchemaSig', () => {
  it('reads id:modified_at from the schemas list filtered by queue', async () => {
    const fetchMock = vi.fn(async () =>
      ok({ results: [{ id: 9, modified_at: '2026-07-28T21:16:47Z' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSchemaSig(D, 't', 42)).toBe('9:2026-07-28T21:16:47Z');
    expect(fetchMock.mock.calls[0]).toEqual([`${D}/api/v1/schemas?queue=42`, expect.anything()]);
  });

  it('returns null when the queue lists no schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ results: [] })));
    expect(await fetchSchemaSig(D, 't', 42)).toBeNull();
  });
});

describe('loadSchemaForQueue signature and 429', () => {
  it('asks the schema for id and modified_at and returns them as sig', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('/queues/')) return ok({ schema: `${D}/api/v1/schemas/9` });
        return ok({ id: 9, modified_at: 's1', content: [] });
      }),
    );
    const info = await loadSchemaForQueue(D, 't', 42);
    expect(info.sig).toBe('9:s1');
    expect(urls[1]).toBe(`${D}/api/v1/schemas/9?fields=content,id,modified_at`);
  });

  it('rethrows a 429 instead of returning an empty schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => throttled));
    await expect(loadSchemaForQueue(D, 't', 42)).rejects.toMatchObject({ status: 429 });
  });

  it('still returns the empty schema on a 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
    expect(await loadSchemaForQueue(D, 't', 42)).toEqual({ types: {}, lookups: [], order: {} });
  });
});

describe('loadMdhHooksForQueue onAttached', () => {
  it('reports every attached hook id, MDH or not, active or not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({
          results: [
            { id: 1, type: 'function', active: true },
            { id: 2, type: 'webhook', active: false },
          ],
        }),
      ),
    );
    let ids: string[] = [];
    const mdh = await loadMdhHooksForQueue(D, 't', 42, (hookIds) => {
      ids = hookIds;
    });
    expect(mdh).toEqual([]);
    expect(ids).toEqual(['1', '2']);
  });
});

describe('sameIds', () => {
  it('ignores order and compares content', () => {
    expect(sameIds(['1', '2'], ['2', '1'])).toBe(true);
    expect(sameIds(['1'], ['1', '2'])).toBe(false);
    expect(sameIds(['1', '3'], ['1', '2'])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/popup-revalidate-fetch.test.ts`
Expected: FAIL — `fetchQueueHookIds` / `fetchSchemaSig` / `sameIds` are not exported.

- [ ] **Step 3: Implement in `src/popup/mdh-provenance.ts`**

Extend the Task 2 import to `import { isRateLimited, rateLimitError } from '../net/rateLimit.js';`.

Replace `QueueSchemaInfo`:

```ts
export type QueueSchemaInfo = {
  types: Record<string, string>;
  lookups: any[];
  order: Record<string, number>;
  // `${id}:${modified_at}` of the schema; absent when the API did not return both.
  sig?: string;
};
```

Replace `fetchQueueSchemaContent` with:

```ts
// The schema's identity, comparable across the detail route and the schemas list.
function schemaSig(schema: any): string | null {
  return schema?.id != null && schema?.modified_at ? `${schema.id}:${schema.modified_at}` : null;
}

async function fetchQueueSchema(
  domain: string,
  token: string,
  queueId: string | number,
): Promise<{ content: any[]; sig: string | null } | null> {
  const queue = await fetchJson(`${domain}/api/v1/queues/${queueId}?fields=schema`, token);
  const schemaUrl = queue?.schema;
  if (!schemaUrl) return null;
  const schema = await fetchJson(`${schemaUrl}?fields=content,id,modified_at`, token);
  return { content: schema?.content || [], sig: schemaSig(schema) };
}

// The queue's schema identity from the schemas list: one small request, no content
// (spec 2026-10-13 §2c). Compared with the cached `sig` once the cache window ends.
export async function fetchSchemaSig(
  domain: string,
  token: string,
  queueId: string | number,
): Promise<string | null> {
  const resp = await fetchJson(`${domain}/api/v1/schemas?queue=${queueId}`, token);
  return schemaSig(resp?.results?.[0]);
}
```

Replace `loadSchemaForQueue`'s body:

```ts
  const empty = { types: {}, lookups: [], order: {} };
  try {
    const schema = await fetchQueueSchema(domain, token, queueId);
    if (!schema) return empty;
    return {
      types: buildSchemaTypes(schema.content),
      lookups: extractLookupConfigs(schema.content),
      order: buildSchemaOrder(schema.content),
      ...(schema.sig ? { sig: schema.sig } : {}),
    };
  } catch (err) {
    // A 429 must not read as "this schema has no fields" (spec 2026-10-13 §4.4).
    if (isRateLimited(err)) throw err;
    return empty;
  }
```

In `resolveLookupVariables`, replace the first line of the body with:

```ts
  const schemaContent = (await fetchQueueSchema(domain, token, queueId))?.content;
```

Replace `loadMdhHooksForQueue`:

```ts
export async function loadMdhHooksForQueue(
  domain: string,
  token: string,
  queueId: string | number,
  onAttached?: (hookIds: string[]) => void,
): Promise<any[]> {
  const hooksResp = await fetchJson(`${domain}/api/v1/hooks?queue=${queueId}&page_size=100`, token);
  const all: any[] = hooksResp?.results || [];
  // Every attached hook, MDH or not: the popup cache compares these ids with the
  // queue's own `hooks` list to notice a newly attached hook (spec 2026-10-13 §4.4).
  if (onAttached) onAttached(all.map((h) => String(h.id)));
  return all.filter((h) => h.active !== false && h.type === 'webhook').filter(isMdhHook);
}

// The queue's attached hook ids, read off the queue itself: ~250 bytes, where the
// hooks list is every full hook object (the list ignores `fields=`; spec 2026-10-13 §2c).
export async function fetchQueueHookIds(
  domain: string,
  token: string,
  queueId: string | number,
): Promise<string[]> {
  const queue = await fetchJson(`${domain}/api/v1/queues/${queueId}?fields=hooks`, token);
  return (queue?.hooks || [])
    .map((u: unknown) => extractIdFromUrl(u))
    .filter((id: string | null): id is string => id !== null);
}

export function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = [...b].sort();
  return [...a].sort().every((id, i) => id === sb[i]);
}
```

- [ ] **Step 4: Run the popup data suites**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/popup-revalidate-fetch.test.ts tests/mdh-provenance.test.ts tests/mdh-provenance-lookup.test.ts tests/popup-mdh-lookup-panel.test.tsx`
Expected: PASS. (The existing `loadSchemaForQueue` tests still match: their schema fixtures have no `id`/`modified_at`, so no `sig` key appears.)

- [ ] **Step 5: Mutation-check**

Remove `if (isRateLimited(err)) throw err;` from `loadSchemaForQueue`; the 429 test must fail. Restore.

- [ ] **Step 6: Commit** — after Task 7, because `fetchQueueHookIds`, `fetchSchemaSig` and `sameIds` have no `src/` importer until Task 8 and `tests/dead-code.test.ts` would fail. Continue to Task 7, and commit Tasks 6–8 together at the end of Task 8.

---

### Task 7: Popup cache entries that can be confirmed

**Files:**
- Modify: `src/popup/cache.ts` (hook and schema caches)
- Test: `tests/popup-cache.test.ts` (one expectation updated; new cases appended)

**Interfaces:**
- Produces:
  - `type CachedHooks = { entries: any[]; hadHooks: boolean; hookIds: string[] | null; stale: boolean }`
  - `getCachedHookEntries(domain, queueId): Promise<CachedHooks | null>` — `hadHooks: false` with `hookIds` → always returned, `stale: true` (no window); otherwise `null` past 5 minutes, `stale: false` within.
  - `setCachedHookEntries(domain, queueId, entries, meta: { hadHooks: boolean; hookIds: string[] }): Promise<void>`
  - `CachedSchema` gains `sig?: string`; `getCachedSchema` returns `(CachedSchema & { stale: boolean }) | null` — past the window, an entry WITH `sig` is returned with `stale: true`, one without expires as before.

- [ ] **Step 1: Update the existing expectation and write the failing cases**

In `tests/popup-cache.test.ts`, the first round-trip test now also expects `stale: false`:

```ts
    expect(await getCachedSchema('https://d', '7')).toEqual({
      types: { cust: 'string' },
      lookups: [],
      order: { cust: 0 },
      stale: false,
    });
```

Change the import line to:

```ts
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCachedHookEntries,
  getCachedSchema,
  setCachedHookEntries,
  setCachedSchema,
} from '../src/popup/cache.js';
```

Append:

```ts
// ── Spec 2026-10-13-api-call-reduction-design.md §4.4 ──
const SIX_MINUTES = 6 * 60 * 1000;

describe('popup cache — hook entries that can be confirmed', () => {
  let data: Record<string, any>;
  beforeEach(() => {
    data = stubSessionStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a queue with no MDH hook is always returned, stale, with its hook ids', async () => {
    await setCachedHookEntries('https://d', '42', [], { hadHooks: false, hookIds: ['60'] });
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedHookEntries('https://d', '42')).toEqual({
      entries: [],
      hadHooks: false,
      hookIds: ['60'],
      stale: true,
    });
  });

  it('hooks that exist but do not apply keep the 5-minute window', async () => {
    await setCachedHookEntries('https://d', '42', [], { hadHooks: true, hookIds: ['50'] });
    expect(await getCachedHookEntries('https://d', '42')).toMatchObject({
      hadHooks: true,
      stale: false,
    });
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedHookEntries('https://d', '42')).toBeNull();
  });

  it('an entry from before this change is served inside the window and expires after', async () => {
    data['mdhProv:hooks:v3:https://d#42'] = {
      entries: [{ hook: { id: 1, name: 'H' }, cfgs: [] }],
      fetchedAt: Date.now(),
    };
    expect(await getCachedHookEntries('https://d', '42')).toEqual({
      entries: [{ hook: { id: 1, name: 'H' }, cfgs: [] }],
      hadHooks: true,
      hookIds: null,
      stale: false,
    });
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedHookEntries('https://d', '42')).toBeNull();
  });
});

describe('popup cache — schema signature', () => {
  beforeEach(() => {
    stubSessionStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SCHEMA = { types: {}, lookups: [], order: {} };

  it('past the window, an entry with a signature is returned stale', async () => {
    await setCachedSchema('https://d', '42', { ...SCHEMA, sig: '9:s1' });
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedSchema('https://d', '42')).toEqual({
      ...SCHEMA,
      sig: '9:s1',
      stale: true,
    });
  });

  it('past the window, an entry without a signature expires as before', async () => {
    await setCachedSchema('https://d', '42', SCHEMA);
    vi.setSystemTime(Date.now() + SIX_MINUTES);
    expect(await getCachedSchema('https://d', '42')).toBeNull();
  });
});
```

`stubSessionStorage` already returns its `data` object; give that object a type so the assignment above type-checks: change `const data = {};` to `const data: Record<string, any> = {};` inside it.

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/popup-cache.test.ts`
Expected: FAIL — `getCachedHookEntries` returns a bare array; `stale` missing.

- [ ] **Step 3: Implement in `src/popup/cache.ts`**

Replace the hook-entry pair:

```ts
export type CachedHooks = {
  entries: any[];
  hadHooks: boolean;
  hookIds: string[] | null;
  stale: boolean;
};

export async function getCachedHookEntries(
  domain: string,
  queueId: string | number,
): Promise<CachedHooks | null> {
  const key = hooksKey(domain, queueId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key] as
    | Cached<{ entries: any[]; hadHooks?: boolean; hookIds?: string[] }>
    | undefined;
  if (!entry?.fetchedAt) return null;
  // Entries written before 2026-10-13 were never empty, so a missing flag means hooks.
  const hadHooks = entry.hadHooks !== false;
  const hookIds = Array.isArray(entry.hookIds) ? entry.hookIds : null;
  // No MDH hook attached: no trust window. The panel shows the entry and confirms it
  // against the queue's attached hooks on every open (spec 2026-10-13 §4.4).
  if (!hadHooks && hookIds) return { entries: entry.entries, hadHooks, hookIds, stale: true };
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return { entries: entry.entries, hadHooks, hookIds, stale: false };
}

export async function setCachedHookEntries(
  domain: string,
  queueId: string | number,
  entries: any[],
  meta: { hadHooks: boolean; hookIds: string[] },
): Promise<void> {
  // Persist only the fields the popup uses; avoid the full hook detail blob.
  const trimmed = entries.map(({ hook, cfgs }: { hook: any; cfgs: any }) => ({
    hook: { id: hook.id, name: hook.name },
    cfgs,
  }));
  await chrome.storage.session.set({
    [hooksKey(domain, queueId)]: {
      entries: trimmed,
      hadHooks: meta.hadHooks,
      hookIds: meta.hookIds,
      fetchedAt: Date.now(),
    },
  });
}
```

Replace `CachedSchema` and `getCachedSchema`:

```ts
export type CachedSchema = {
  types: Record<string, string>;
  lookups: any[];
  order: Record<string, number>;
  sig?: string; // `${id}:${modified_at}`, compared once the window ends (spec 2026-10-13 §4.4)
};

export async function getCachedSchema(
  domain: string,
  queueId: string | number,
): Promise<(CachedSchema & { stale: boolean }) | null> {
  if (!queueId) return null;
  const key = schemaKey(domain, queueId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key] as Cached<CachedSchema> | undefined;
  if (!entry?.fetchedAt) return null;
  const stale = Date.now() - entry.fetchedAt > TTL_MS;
  // Past the window an entry with a signature is still shown, and the panel confirms it
  // with one small request; an entry without one (older builds) expires as before.
  if (stale && !entry.sig) return null;
  return {
    types: entry.types,
    lookups: entry.lookups,
    order: entry.order,
    ...(entry.sig ? { sig: entry.sig } : {}),
    stale,
  };
}
```

- [ ] **Step 4: Run the cache tests**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/popup-cache.test.ts`
Expected: PASS. (`npm run typecheck` fails until Task 8 updates the panel's calls — expected.)

- [ ] **Step 5: Mutation-check**

Change `entry.hadHooks !== false` to `entry.hadHooks === true`; the "before this change" test must fail. Restore.

- [ ] **Step 6: Commit** — together with Task 8.

---

### Task 8: The popup card confirms stale entries in the background

**Files:**
- Modify: `src/popup/components/MdhProvenancePanel.tsx` (imports; the effect's hook block, schema block, empty-result return, values-load catch, freshness block, outer catch)
- Test: `tests/popup-mdh-revalidate.test.tsx`

**Interfaces:**
- Consumes: `getCachedHookEntries`, `setCachedHookEntries`, `getCachedSchema`, `CachedSchema` (Task 7); `loadMdhHooksForQueue(…, onAttached)`, `fetchQueueHookIds`, `fetchSchemaSig`, `sameIds` (Task 6); `isRateLimited`, `rateLimitMessage` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/popup-mdh-revalidate.test.tsx
// @vitest-environment jsdom
// Spec 2026-10-13-api-call-reduction-design.md §4.4: what a warm popup open sends.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import MdhProvenancePanel from '../src/popup/components/MdhProvenancePanel.jsx';

const DOMAIN = 'https://org.rossum.app';
const TAB = { id: 1, windowId: 7, index: 0, url: `${DOMAIN}/document/5` };
const SCHEMA_URL = `${DOMAIN}/api/v1/schemas/9`;
const OTHER_HOOK = { id: 60, name: 'Other', type: 'function', active: true };
const mdhHook = (queueIds?: number[]) => ({
  id: 50,
  name: 'MDH',
  type: 'webhook',
  active: true,
  settings: {
    configurations: [
      {
        name: 'Vendor',
        ...(queueIds ? { queue_ids: queueIds } : {}),
        source: { dataset: 'vendors', queries: [{ find: { name: '{sender_name}' } }] },
        mapping: { target_schema_id: 'vendor_code', dataset_key: 'code' },
      },
    ],
  },
});
const throttled = (retryAfter: string | null) => ({
  ok: false,
  status: 429,
  headers: { get: (n: string) => (n === 'Retry-After' ? retryAfter : null) },
  json: async () => ({}),
});

let root: HTMLDivElement;
let session: Record<string, any>;
let urls: string[];
let hooksList: any[];
let attached: string[];
let route: (url: string) => any; // per-test override, checked first

async function waitFor(cond: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const message = () => root.querySelector('.mdh-empty')?.textContent;
const count = (part: string) => urls.filter((u) => u.includes(part)).length;
async function open() {
  render(null, root);
  render(<MdhProvenancePanel tab={TAB} />, root);
  await waitFor(() => !!message() && message() !== 'Loading…');
}

beforeEach(() => {
  session = {};
  urls = [];
  hooksList = [OTHER_HOOK];
  attached = ['60'];
  route = () => undefined;
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.stubGlobal('chrome', {
    scripting: {
      // No queue in the URL: the panel resolves it from the annotation.
      executeScript: vi.fn(async () => [
        { result: { token: 'tok', domain: DOMAIN, annotationId: '5', queueId: null } },
      ]),
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn((_o: any, cb?: any) => cb?.()) },
      session: {
        get: vi.fn(async (k: string) => (k in session ? { [k]: session[k] } : {})),
        set: vi.fn(async (o: any) => {
          Object.assign(session, o);
        }),
        remove: vi.fn(async (k: string) => {
          delete session[k];
        }),
      },
    },
    tabs: { create: vi.fn() },
    runtime: { sendMessage: vi.fn(), getURL: (p: string) => `chrome-extension://x/${p}` },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const special = route(url);
      if (special) return special;
      const body = (() => {
        if (url.includes('/annotations/5?fields=url,queue,modified_at'))
          return { queue: `${DOMAIN}/api/v1/queues/42`, modified_at: 'm1' };
        if (url.includes('/annotations/5?fields=modified_at')) return { modified_at: 'm1' };
        if (url.includes('/annotations/5/content')) return { content: [] };
        if (url.includes('/api/v1/hooks?')) return { results: hooksList };
        if (url.includes('/queues/42?fields=hooks'))
          return { hooks: attached.map((id) => `${DOMAIN}/api/v1/hooks/${id}`) };
        if (url.includes('/queues/42?fields=schema')) return { schema: SCHEMA_URL };
        if (url.includes('/schemas?queue=42')) return { results: [{ id: 9, modified_at: 's1' }] };
        if (url.startsWith(SCHEMA_URL)) return { id: 9, modified_at: 's1', content: [] };
        return {};
      })();
      return { ok: true, status: 200, json: async () => body };
    }),
  );
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('MDH card — queue with no MDH hook', () => {
  it('second open is served from cache; only the small checks go out', async () => {
    await open();
    expect(message()).toBe('No MDH matching on this queue.');
    expect(count('/api/v1/hooks?')).toBe(1);
    urls = [];
    await open();
    await waitFor(() => count('/queues/42?fields=hooks') === 1);
    expect(message()).toBe('No MDH matching on this queue.');
    expect(count('/api/v1/hooks?')).toBe(0);
    expect(count('/annotations/5?fields=url,queue,modified_at')).toBe(0);
    expect(count('/annotations/5?fields=modified_at')).toBe(1);
  });

  it('a newly attached hook triggers the full fetch', async () => {
    await open();
    urls = [];
    hooksList = [OTHER_HOOK, mdhHook()];
    attached = ['60', '50'];
    await open();
    await waitFor(() => count('/api/v1/hooks?') === 1);
  });

  it('a failed background check keeps the view and fetches nothing more', async () => {
    await open();
    urls = [];
    route = (url) => (url.includes('/queues/42?fields=hooks') ? throttled(null) : undefined);
    await open();
    await waitFor(() => count('/queues/42?fields=hooks') === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(message()).toBe('No MDH matching on this queue.');
    expect(count('/api/v1/hooks?')).toBe(0);
  });
});

describe('MDH card — hooks attached but none applies', () => {
  it('keeps the message and skips the attachment check inside the window', async () => {
    hooksList = [mdhHook([999])];
    attached = ['50'];
    await open();
    expect(message()).toBe('No MDH configurations apply to this queue.');
    urls = [];
    await open();
    await new Promise((r) => setTimeout(r, 50));
    expect(message()).toBe('No MDH configurations apply to this queue.');
    expect(count('/queues/42?fields=hooks')).toBe(0);
    expect(count('/api/v1/hooks?')).toBe(0);
  });
});

describe('MDH card — schema past its window', () => {
  it('confirms the signature with the schemas list instead of refetching the schema', async () => {
    await open();
    const key = `mdhProv:schema:v2:${DOMAIN}#42`;
    expect(session[key].sig).toBe('9:s1');
    const old = Date.now() - 6 * 60 * 1000;
    session[key].fetchedAt = old;
    urls = [];
    await open();
    await waitFor(() => count('/schemas?queue=42') === 1);
    await waitFor(() => session[key].fetchedAt > old); // the window restarts
    expect(count('/queues/42?fields=schema')).toBe(0);
    expect(count('/schemas/9')).toBe(0);
  });
});

describe('MDH card — 429', () => {
  it('shows the rate-limit message for a throttled hooks list', async () => {
    route = (url) => (url.includes('/api/v1/hooks?') ? throttled('3') : undefined);
    await open();
    expect(message()).toBe('Rossum is rate-limiting requests. Try again in 3 s.');
  });

  it('a throttled schema load is not "No MDH matching"', async () => {
    route = (url) => (url.startsWith(SCHEMA_URL) ? throttled(null) : undefined);
    await open();
    expect(message()).toBe('Rossum is rate-limiting requests. Try again shortly.');
  });

  it('a throttled values load is shown, not cached as empty values', async () => {
    hooksList = [mdhHook()];
    attached = ['50'];
    route = (url) => (url.includes('/annotations/5/content') ? throttled(null) : undefined);
    await open();
    expect(message()).toBe('Rossum is rate-limiting requests. Try again shortly.');
    expect(Object.keys(session).some((k) => k.startsWith('mdhProv:ann:'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/popup-mdh-revalidate.test.tsx`
Expected: FAIL — the second open sends the hooks list again, and the 429 tests show `Failed: …` or "No MDH matching".

- [ ] **Step 3: Update the imports in `MdhProvenancePanel.tsx`**

Add `fetchQueueHookIds`, `fetchSchemaSig` and `sameIds` to the `../mdh-provenance.js` import list (alphabetical, as the list is), add `type CachedSchema` to the `../cache.js` import list, and add:

```ts
import { isRateLimited, rateLimitMessage } from '../../net/rateLimit.js';
```

- [ ] **Step 4: Replace the hook and schema blocks**

Replace from `let hookEntries = null;` through the line `const lookupCfgs = schema.lookups || [];` with:

```tsx
        let hookEntries = null;
        let hadHooks = true;
        // Set when a cached entry must be confirmed in the background (spec 2026-10-13 §4.4).
        let staleHookIds: string[] | null = null;
        if (!forceRefresh) {
          const cached = await getCachedHookEntries(ctx.domain, queueId);
          if (cached) {
            hookEntries = cached.entries;
            hadHooks = cached.hadHooks;
            if (cached.stale) staleHookIds = cached.hookIds;
          }
        }
        if (cancelled) return;
        if (!hookEntries) {
          let hookIds: string[] = [];
          const mdhHooks = await loadMdhHooksForQueue(ctx.domain, ctx.token, queueId, (ids) => {
            hookIds = ids;
          });
          if (cancelled) return;
          hadHooks = mdhHooks.length > 0;
          hookEntries = buildHookEntries(mdhHooks, queueId);
          // An empty list is cached too; `hadHooks` keeps "no hooks" and "no hook applies"
          // apart, which is the message the user reads.
          setCachedHookEntries(ctx.domain, queueId, hookEntries, { hadHooks, hookIds }).catch(
            () => {},
          );
        }

        // The schema carries both the authoritative field types and the lookup
        // fields — a queue can match through lookups alone, with no MDH hook — so
        // it is read BEFORE deciding there is nothing to show.
        const cachedSchema = forceRefresh ? null : await getCachedSchema(ctx.domain, queueId);
        const staleSchema = cachedSchema?.stale ? cachedSchema : null;
        let schema: CachedSchema | null = cachedSchema;
        if (!schema) {
          schema = await loadSchemaForQueue(ctx.domain, ctx.token, queueId);
          setCachedSchema(ctx.domain, queueId, schema).catch(() => {});
        }
        if (cancelled) return;

        // Background checks, after the view renders: confirm a stale hook or schema entry,
        // and the annotation's modified_at when its values came from the cache. A change
        // refetches through refreshNonce; a failure, a 429 included, keeps the view.
        const revalidate = (annFromCache: boolean) => {
          (async () => {
            try {
              const [hookIdsNow, sigNow, ann] = await Promise.all([
                staleHookIds ? fetchQueueHookIds(ctx.domain, ctx.token, queueId) : null,
                staleSchema ? fetchSchemaSig(ctx.domain, ctx.token, queueId) : null,
                annFromCache
                  ? fetchJson(
                      `${ctx.domain}/api/v1/annotations/${ctx.annotationId}?fields=modified_at`,
                      ctx.token,
                    )
                  : null,
              ]);
              if (cancelled) return;
              const hooksChanged =
                !!staleHookIds && !!hookIdsNow && !sameIds(hookIdsNow, staleHookIds);
              const schemaChanged = !!staleSchema && sigNow !== staleSchema.sig;
              const annChanged = !!ann?.modified_at && ann.modified_at !== annotationModifiedAt;
              if (staleSchema && !schemaChanged) {
                // Unchanged: the schema's 5-minute window starts again.
                const { types, lookups, order, sig } = staleSchema;
                setCachedSchema(ctx.domain, queueId, { types, lookups, order, sig }).catch(
                  () => {},
                );
              }
              if (annChanged) await dropCachedAnnotation(ctx.domain, ctx.annotationId);
              if (cancelled) return;
              if (hooksChanged || schemaChanged || annChanged) setRefreshNonce((n) => n + 1);
            } catch {
              // best-effort; keep the cached view
            }
          })();
        };

        const lookupCfgs = schema.lookups || [];
```

- [ ] **Step 5: Replace the empty-result return**

Replace the `if (hookEntries.length === 0 && lookupCfgs.length === 0) { … return; }` block with:

```tsx
        if (hookEntries.length === 0 && lookupCfgs.length === 0) {
          // Remember the annotation's queue too, so the next open skips the annotation
          // GET. Its values are empty, so a hook added later finds nothing "covered".
          if (!annCache && annotationModifiedAt) {
            setCachedAnnotation(ctx.domain, ctx.annotationId, {
              modifiedAt: annotationModifiedAt,
              queueId,
              headerValues: {},
              rowValues: {},
              rowCount: 0,
              tables: [],
              types: {},
              lookupResults: {},
              placeholders: '',
              lookupIds: '',
            }).catch(() => {});
          }
          setState({
            kind: 'message',
            message: hadHooks
              ? 'No MDH configurations apply to this queue.'
              : 'No MDH matching on this queue.',
          });
          revalidate(!!annCache);
          return;
        }
```

- [ ] **Step 6: Let a 429 through the values load**

Replace the inner `catch { // leave defaults }` after `loadAnnotationValues` with:

```tsx
          } catch (err) {
            // A 429 must not be cached as empty values (spec 2026-10-13 §4.4).
            if (isRateLimited(err)) throw err;
            // anything else: leave defaults
          }
```

- [ ] **Step 7: Replace the freshness block and the outer catch**

Replace the whole `// Best-effort freshness check: …` block (the comment and the `if (annValuesFromCache && ctx.annotationId) { (async () => { … })(); }` statement) with:

```tsx
        revalidate(annValuesFromCache);
```

In the outer `catch (e: any)`, directly after `if (cancelled) return;`:

```tsx
        if (isRateLimited(e)) {
          setState({ kind: 'message', message: rateLimitMessage(e), isError: true });
          return;
        }
```

- [ ] **Step 8: Run the popup suites**

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/popup-mdh-revalidate.test.tsx tests/popup-cache.test.ts tests/popup-revalidate-fetch.test.ts tests/popup-mdh-lookup-panel.test.tsx tests/popup-mdh-multi-table.test.tsx tests/popup-mdh-pin.test.tsx tests/popup-mdh-row-scope.test.tsx tests/popup-query-hint.test.tsx tests/popup-action-condition.test.ts`
Expected: PASS.

- [ ] **Step 9: Mutation-check**

1. Remove `if (isRateLimited(err)) throw err;` from the values-load catch → "throttled values load" must fail.
2. Change `if (cached.stale) staleHookIds = cached.hookIds;` to `staleHookIds = null;` → "a newly attached hook" must fail.
3. Remove the `setCachedSchema(…)` call inside `if (staleSchema && !schemaChanged)` → the schema test must fail on the restarted window.

Restore each.

- [ ] **Step 10: Typecheck, dead-code and the full suite**

Run: `npm run typecheck && NODE_OPTIONS=--no-experimental-webstorage npm test`
Expected: both PASS.

- [ ] **Step 11: Commit Tasks 6–8**

```bash
git add src/popup/mdh-provenance.ts src/popup/cache.ts src/popup/components/MdhProvenancePanel.tsx tests/popup-revalidate-fetch.test.ts tests/popup-cache.test.ts tests/popup-mdh-revalidate.test.tsx
git commit -m "perf(popup): confirm cached MDH data with small requests, and show 429s

An empty queue refetched its full hooks list on every open; a stale schema
cost two requests. A 429 read as \"No MDH matching\" or as empty values.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Document the rule, then verify the whole branch

**Files:**
- Modify: `CLAUDE.md` (one bullet under "Conventions & traps"; one line under "Where the design detail lives")

- [ ] **Step 1: Add the convention** — append to the "Conventions & traps" list in `CLAUDE.md`:

```markdown
- **A 429 is never "empty" and never retried automatically.** Every transport that talks to the
  Rossum API throws `rateLimitError` from `src/net/rateLimit.ts`, and code that maps an error to
  an empty result (`safe()` in the Inspector, `loadSchemaForQueue` in the popup) must let a 429
  through or record it. The user retries — Refresh, reopen, Retry. The API ignores `fields=` on
  list endpoints (measured 2026-10-13), so a "cheap" list check downloads every full object;
  `/queues/{id}?fields=hooks` and `/schemas?queue={id}` are the small ones.
```

and add to the bullet list under "Where the design detail lives":

```markdown
- **API calls and 429s** — `2026-10-13-api-call-reduction-design.md` (the Inspector request
  scope, Galaxy's abort on 429, the popup's background checks)
```

- [ ] **Step 2: Full verification**

Run, in order, and confirm each passes:

```bash
npm run typecheck
NODE_OPTIONS=--no-experimental-webstorage npm test
npm run format:check
npm run build
```

If `format:check` fails, run `npm run format` and run `format:check` again (Prettier can need two passes on a new file).

- [ ] **Step 3: Customer-data check of the diff**

Run: `git diff master --stat && git diff master | grep -n -i -E 'rossum\.app|\.rossum\.ai'`
Expected: only `org.rossum.app`, `x.rossum.app`, `x.rossum.ai` and `elis.rossum.ai`. Any other host, org name, hook name or dataset prefix must be replaced with a placeholder.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the 429 rule and the list endpoints' ignored fields=

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand off**

Do not push and do not open a PR. Report to the owner: the commits on `api-call-hygiene`, the four verification results, and anything a mutation check showed.
