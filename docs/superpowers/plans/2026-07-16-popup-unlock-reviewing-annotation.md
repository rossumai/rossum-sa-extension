# Popup "Reviewing-Lock" Warning + Force-Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the popup is opened on a Rossum annotation that another user holds in `reviewing`, show a warning banner naming the holder and offer a one-click "Return to 'To Review'" that force-releases the lock (`PATCH {status:"to_review"}`) and reloads the tab.

**Architecture:** One pure helper module (`reviewingLock.js`), one tiny write helper (`apiPatch` beside `fetchJson`), one self-contained Preact component (`ReviewingLockBanner.jsx`) with dependency-injected IO (repo pattern: devtools `actions.js`), mounted at the top of `#mainContent` in `App.jsx`. Spec: `docs/superpowers/specs/2026-07-16-popup-unlock-reviewing-annotation-design.md` (all API facts there are live-verified — do not re-derive them).

**Tech Stack:** Preact + hooks (popup), Vitest (+jsdom pragma per file), esbuild via `npm run build`.

## Global Constraints

- **NO per-task git commits.** Owner rule: one commit for the whole run, at the very end (Task 5), on `master`, message WITHOUT any `Co-Authored-By` trailer.
- Tests are `.test.js` files in `tests/`; **no raw JSX in test files** (oxc breaks) — use `h(Component, props)`. Component tests need `// @vitest-environment jsdom` as the first line.
- **No fixed-timeout waits in tests** — use the condition-based `waitFor` loop shown in Task 3.
- Rossum `/api/v1` auth header is `Authorization: token <token>` (NOT `Bearer`) — `fetchJson` already does this; `apiPatch` must match.
- Trigger predicate (verified): `status === 'reviewing' && modified_by !== <me.url>`. If `modified_by` is missing → treat as NOT locked-by-other (hide; never guess).
- Release primitive (verified): `PATCH /api/v1/annotations/{id}` body `{"status":"to_review"}`. Never call `/cancel` (409s for non-holders), never patch `queue`.
- Exact user-facing copy (verbatim):
  - Title: `Being reviewed by {holderName}`
  - Sub: `You have this document open read-only.`
  - Button: `Return to “To Review”` (busy: `Releasing…`)
  - Caption: `Ends their review session — any unsaved edits of theirs are lost, as if it timed out. No re-extraction.`
  - Errors: 403 → `You don't have permission to release this document.`; 401 → `Sign in to Rossum in this tab first.`; other → `Couldn't release the document — try again.`
  - Staleness: `In review for ~{age} · lock expires after {timeout}` / `Review session looks expired.`
- JSX unicode gotcha (CLAUDE.md): `\uXXXX` does NOT work in JSX text children — use literal glyphs (`…`, `—`, `“ ”`) or `{'…'}` expressions.
- No new storage keys, no manifest changes, no new permissions. Feature degrades to rendering nothing on ANY read failure.
- After implementation: `npm run build` (the loaded extension runs `dist/`, not `src/`).

---

### Task 1: Pure helpers `src/popup/reviewingLock.js`

**Files:**
- Create: `src/popup/reviewingLock.js`
- Test: `tests/popup-reviewing-lock.test.js`

**Interfaces:**
- Consumes: nothing (pure, DOM-free, chrome-free).
- Produces (used by Task 3):
  - `isLockedByOther({ status, modifiedBy, meUrl }) → boolean`
  - `pickHolderName(user) → string` (`user` = `{first_name, last_name, username}` or null)
  - `parseHmsToMs(str) → number|null` (DRF duration `"[DD ]HH:MM:SS[.ffffff]"`)
  - `formatDuration(ms) → string` (`"under a minute"`, `"12 min"`, `"1h"`, `"1h 30 min"`)
  - `stalenessLabel(assignedAtIso, sessionTimeoutStr, nowMs) → string` (`''` when unknowable)

- [ ] **Step 1: Write the failing test**

Create `tests/popup-reviewing-lock.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  isLockedByOther,
  pickHolderName,
  parseHmsToMs,
  formatDuration,
  stalenessLabel,
} from '../src/popup/reviewingLock.js';

const ME = 'https://api.example.com/api/v1/users/1';
const OTHER = 'https://api.example.com/api/v1/users/2';

describe('isLockedByOther', () => {
  it('is true only for reviewing + a different modified_by', () => {
    expect(isLockedByOther({ status: 'reviewing', modifiedBy: OTHER, meUrl: ME })).toBe(true);
  });
  it('is false when I am the modifier (I hold it elsewhere)', () => {
    expect(isLockedByOther({ status: 'reviewing', modifiedBy: ME, meUrl: ME })).toBe(false);
  });
  it('is false for any non-reviewing status', () => {
    for (const status of ['to_review', 'confirmed', 'exported', 'importing', 'deleted']) {
      expect(isLockedByOther({ status, modifiedBy: OTHER, meUrl: ME })).toBe(false);
    }
  });
  it('is false (never guess) when modified_by or meUrl is missing', () => {
    expect(isLockedByOther({ status: 'reviewing', modifiedBy: null, meUrl: ME })).toBe(false);
    expect(isLockedByOther({ status: 'reviewing', modifiedBy: OTHER, meUrl: undefined })).toBe(false);
  });
});

describe('pickHolderName', () => {
  it('formats "First Last (username)"', () => {
    expect(pickHolderName({ first_name: 'Jane', last_name: 'Doe', username: 'jd@x.com' }))
      .toBe('Jane Doe (jd@x.com)');
  });
  it('falls back to username alone, then full name alone', () => {
    expect(pickHolderName({ first_name: '', last_name: '', username: 'jd@x.com' })).toBe('jd@x.com');
    expect(pickHolderName({ first_name: 'Jane', last_name: 'Doe' })).toBe('Jane Doe');
  });
  it('falls back to "another user" for null/empty', () => {
    expect(pickHolderName(null)).toBe('another user');
    expect(pickHolderName({})).toBe('another user');
  });
});

describe('parseHmsToMs', () => {
  it('parses HH:MM:SS', () => {
    expect(parseHmsToMs('01:00:00')).toBe(3600000);
    expect(parseHmsToMs('00:05:30')).toBe(330000);
  });
  it('parses the DRF days prefix and fractional seconds', () => {
    expect(parseHmsToMs('1 00:00:00')).toBe(86400000);
    expect(parseHmsToMs('00:00:01.500000')).toBe(1000); // fraction truncated
  });
  it('returns null for garbage', () => {
    expect(parseHmsToMs('')).toBeNull();
    expect(parseHmsToMs(null)).toBeNull();
    expect(parseHmsToMs('1h')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(30_000)).toBe('under a minute');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(3600_000)).toBe('1h');
    expect(formatDuration(90 * 60_000)).toBe('1h 30 min');
  });
});

describe('stalenessLabel', () => {
  const NOW = Date.parse('2026-07-16T12:00:00Z');
  it('shows age + expiry while the lock is active', () => {
    expect(stalenessLabel('2026-07-16T11:48:00Z', '01:00:00', NOW))
      .toBe('In review for ~12 min · lock expires after 1h');
  });
  it('shows the expired line when age >= timeout', () => {
    expect(stalenessLabel('2026-07-16T10:00:00Z', '01:00:00', NOW))
      .toBe('Review session looks expired.');
  });
  it('omits expiry when the timeout is unknown', () => {
    expect(stalenessLabel('2026-07-16T11:48:00Z', undefined, NOW)).toBe('In review for ~12 min');
  });
  it('returns empty for a missing/invalid assigned_at or negative age', () => {
    expect(stalenessLabel(null, '01:00:00', NOW)).toBe('');
    expect(stalenessLabel('not-a-date', '01:00:00', NOW)).toBe('');
    expect(stalenessLabel('2026-07-16T13:00:00Z', '01:00:00', NOW)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/popup-reviewing-lock.test.js`
Expected: FAIL — `Cannot find module '../src/popup/reviewingLock.js'`

- [ ] **Step 3: Write the implementation**

Create `src/popup/reviewingLock.js`:

```js
// Pure helpers for the "someone else is reviewing this annotation" popup
// banner. All facts verified live on elis 2026-07-16 (see the design spec):
// the lock IS status==='reviewing'; the holder IS modified_by; a missing
// modified_by means we cannot attribute the lock, so we stay silent.

export function isLockedByOther({ status, modifiedBy, meUrl }) {
  return status === 'reviewing' && !!modifiedBy && !!meUrl && modifiedBy !== meUrl;
}

// Mirrors the DevTools panel's pickName conventions for user objects.
export function pickHolderName(user) {
  if (!user || typeof user !== 'object') return 'another user';
  const full = [user.first_name, user.last_name]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ');
  const username = (user.username || '').trim();
  if (full && username) return `${full} (${username})`;
  return full || username || 'another user';
}

// DRF DurationField wire format: "[DD ]HH:MM:SS[.ffffff]" (e.g. "01:00:00").
export function parseHmsToMs(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(?:(\d+)\s+)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!m) return null;
  const [, days, h, min, s] = m;
  return (Number(days || 0) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s)) * 1000;
}

export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return 'under a minute';
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const rest = totalMin % 60;
  return rest === 0 ? `${h}h` : `${h}h ${rest} min`;
}

// '' means "don't show a staleness line" (unknowable), never a guess.
export function stalenessLabel(assignedAtIso, sessionTimeoutStr, nowMs) {
  const started = Date.parse(assignedAtIso || '');
  if (Number.isNaN(started)) return '';
  const age = nowMs - started;
  if (age < 0) return '';
  const timeout = parseHmsToMs(sessionTimeoutStr);
  if (timeout != null && age >= timeout) return 'Review session looks expired.';
  const base = `In review for ~${formatDuration(age)}`;
  return timeout != null ? `${base} · lock expires after ${formatDuration(timeout)}` : base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/popup-reviewing-lock.test.js`
Expected: PASS (5 describe blocks, all green). Do NOT commit (Global Constraints).

---

### Task 2: `apiPatch` write helper

**Files:**
- Modify: `src/popup/mdh-provenance.js` (insert directly after `fetchJson`, i.e. after line 15)
- Test: `tests/popup-api-patch.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 3): `apiPatch(url, token, body) → Promise<object>` — PATCH with `Authorization: token <token>`, JSON body; throws `Error('HTTP <status>')` on non-ok (same contract as `fetchJson`).

- [ ] **Step 1: Write the failing test**

Create `tests/popup-api-patch.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiPatch } from '../src/popup/mdh-provenance.js';

afterEach(() => vi.unstubAllGlobals());

describe('apiPatch', () => {
  it('sends a JSON PATCH with token auth and returns the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'to_review' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await apiPatch('https://x.example/api/v1/annotations/7', 'tok123', { status: 'to_review' });

    expect(out).toEqual({ status: 'to_review' });
    expect(fetchMock).toHaveBeenCalledWith('https://x.example/api/v1/annotations/7', {
      method: 'PATCH',
      headers: {
        Authorization: 'token tok123',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ status: 'to_review' }),
    });
  });

  it('throws Error("HTTP <status>") on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(apiPatch('https://x.example/a', 't', {})).rejects.toThrow('HTTP 403');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/popup-api-patch.test.js`
Expected: FAIL — `apiPatch` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/popup/mdh-provenance.js`, insert after the `fetchJson` function (after line 15):

```js
// Single write helper for the popup (the reviewing-lock force-release).
// Same auth + error contract as fetchJson above.
export async function apiPatch(url, token, body) {
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
```

- [ ] **Step 4: Run tests to verify they pass (new + existing consumers)**

Run: `npx vitest run tests/popup-api-patch.test.js tests/mdh-provenance.test.js`
Expected: both files PASS (proves the edit didn't disturb existing exports). No commit.

---

### Task 3: `probeLock` + `ReviewingLockBanner` component

**Files:**
- Create: `src/popup/components/ReviewingLockBanner.jsx`
- Test: `tests/popup-reviewing-lock-banner.test.js`

**Interfaces:**
- Consumes: Task 1 helpers; Task 2 `apiPatch`; existing `runInTab` (`src/popup/utils.js`), `readCurrentContext` (`src/popup/tab-readers.js`), `fetchJson` + `extractIdFromUrl` (`src/popup/mdh-provenance.js`; `extractIdFromUrl(url) → string|null`).
- Produces (used by Task 4): default export `ReviewingLockBanner({ tab, deps })` — renders `null` unless locked-by-other. Named export `probeLock(tabId, deps) → Promise<null | { ctx, holderName, staleness }>`. `deps` (all optional, for tests): `{ readCtx, getJson, patch, reloadTab, closePopup, now }`.

- [ ] **Step 1: Write the failing test**

Create `tests/popup-reviewing-lock-banner.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import ReviewingLockBanner, { probeLock } from '../src/popup/components/ReviewingLockBanner.jsx';

// Condition-based wait — never fixed timeouts (repo rule).
async function waitFor(cond, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const DOMAIN = 'https://org.rossum.app';
const CTX = { token: 'tok', domain: DOMAIN, annotationId: '138328520', queueId: null };
const ME = `${DOMAIN}/api/v1/users/1`;
const OTHER = `${DOMAIN}/api/v1/users/2`;

// getJson stub routed by URL substring.
function makeGetJson({ ann, me, holder, queue }) {
  return vi.fn(async (url) => {
    if (url.includes('/api/v1/annotations/')) return ann;
    if (url.includes('/api/v1/auth/user')) return me;
    if (url.includes('/api/v1/users/')) return holder;
    if (url.includes('/api/v1/queues/')) return queue;
    throw new Error(`unexpected url ${url}`);
  });
}

const LOCKED_ANN = {
  status: 'reviewing',
  modified_by: OTHER,
  modifier: OTHER,
  queue: `${DOMAIN}/api/v1/queues/9`,
  assigned_at: '2026-07-16T11:48:00Z',
};

function makeDeps(overrides = {}) {
  return {
    readCtx: vi.fn().mockResolvedValue(CTX),
    getJson: makeGetJson({
      ann: LOCKED_ANN,
      me: { url: ME },
      holder: { first_name: 'Jane', last_name: 'Doe', username: 'jd@x.com' },
      queue: { session_timeout: '01:00:00' },
    }),
    patch: vi.fn().mockResolvedValue({ status: 'to_review' }),
    reloadTab: vi.fn(),
    closePopup: vi.fn(),
    now: () => Date.parse('2026-07-16T12:00:00Z'),
    ...overrides,
  };
}

function mount(deps) {
  const root = document.createElement('div');
  render(h(ReviewingLockBanner, { tab: { id: 42 }, deps }), root);
  return root;
}

describe('probeLock', () => {
  it('returns null when there is no annotation in the tab', async () => {
    const deps = makeDeps({ readCtx: vi.fn().mockResolvedValue({ ...CTX, annotationId: null }) });
    expect(await probeLock(42, deps)).toBeNull();
    expect(deps.getJson).not.toHaveBeenCalled();
  });

  it('returns null when the annotation is not reviewing', async () => {
    const deps = makeDeps();
    deps.getJson = makeGetJson({ ann: { ...LOCKED_ANN, status: 'to_review' }, me: { url: ME } });
    expect(await probeLock(42, deps)).toBeNull();
  });

  it('returns null when I am the modifier myself', async () => {
    const deps = makeDeps();
    deps.getJson = makeGetJson({ ann: { ...LOCKED_ANN, modified_by: ME }, me: { url: ME } });
    expect(await probeLock(42, deps)).toBeNull();
  });

  it('resolves holder name and staleness when locked by another user', async () => {
    const res = await probeLock(42, makeDeps());
    expect(res.holderName).toBe('Jane Doe (jd@x.com)');
    expect(res.staleness).toBe('In review for ~12 min · lock expires after 1h');
    expect(res.ctx).toEqual(CTX);
  });

  it('degrades to "another user" / no staleness when those side reads fail', async () => {
    const deps = makeDeps();
    const base = deps.getJson;
    deps.getJson = vi.fn(async (url) => {
      if (url.includes('/api/v1/users/') || url.includes('/api/v1/queues/')) throw new Error('HTTP 403');
      return base(url);
    });
    const res = await probeLock(42, deps);
    expect(res.holderName).toBe('another user');
    expect(res.staleness).toBe('');
  });

  it('returns null when the annotation read itself fails', async () => {
    const deps = makeDeps({ getJson: vi.fn().mockRejectedValue(new Error('HTTP 500')) });
    expect(await probeLock(42, deps)).toBeNull();
  });
});

describe('ReviewingLockBanner', () => {
  it('renders nothing when not locked-by-other', async () => {
    const deps = makeDeps({ readCtx: vi.fn().mockResolvedValue({ ...CTX, annotationId: null }) });
    const root = mount(deps);
    await waitFor(() => deps.readCtx.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.reviewing-lock-banner')).toBeNull();
  });

  it('renders the banner with holder, staleness, caption and button', async () => {
    const root = mount(makeDeps());
    await waitFor(() => root.querySelector('.reviewing-lock-banner'));
    expect(root.textContent).toContain('Being reviewed by Jane Doe (jd@x.com)');
    expect(root.textContent).toContain('You have this document open read-only.');
    expect(root.textContent).toContain('In review for ~12 min · lock expires after 1h');
    expect(root.textContent).toContain('Ends their review session');
    expect(root.querySelector('.rlb-release').textContent).toContain('Return to');
  });

  it('release success: PATCHes status, reloads the tab, closes the popup', async () => {
    const deps = makeDeps();
    const root = mount(deps);
    await waitFor(() => root.querySelector('.rlb-release'));
    root.querySelector('.rlb-release').click();
    await waitFor(() => deps.reloadTab.mock.calls.length > 0);
    expect(deps.patch).toHaveBeenCalledWith(
      `${DOMAIN}/api/v1/annotations/138328520`,
      'tok',
      { status: 'to_review' },
    );
    expect(deps.reloadTab).toHaveBeenCalledWith(42);
    expect(deps.closePopup).toHaveBeenCalled();
  });

  it('release 403: shows the permission error and re-enables the button', async () => {
    const deps = makeDeps({ patch: vi.fn().mockRejectedValue(new Error('HTTP 403')) });
    const root = mount(deps);
    await waitFor(() => root.querySelector('.rlb-release'));
    root.querySelector('.rlb-release').click();
    await waitFor(() => root.querySelector('.rlb-error'));
    expect(root.querySelector('.rlb-error').textContent)
      .toBe("You don't have permission to release this document.");
    expect(root.querySelector('.rlb-release').disabled).toBe(false);
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  it('release 401: shows the sign-in error', async () => {
    const deps = makeDeps({ patch: vi.fn().mockRejectedValue(new Error('HTTP 401')) });
    const root = mount(deps);
    await waitFor(() => root.querySelector('.rlb-release'));
    root.querySelector('.rlb-release').click();
    await waitFor(() => root.querySelector('.rlb-error'));
    expect(root.querySelector('.rlb-error').textContent).toBe('Sign in to Rossum in this tab first.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/popup-reviewing-lock-banner.test.js`
Expected: FAIL — module `ReviewingLockBanner.jsx` not found.

- [ ] **Step 3: Write the implementation**

Create `src/popup/components/ReviewingLockBanner.jsx`:

```jsx
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { runInTab } from '../utils.js';
import { readCurrentContext } from '../tab-readers.js';
import { fetchJson, apiPatch, extractIdFromUrl } from '../mdh-provenance.js';
import { isLockedByOther, pickHolderName, stalenessLabel } from '../reviewingLock.js';

// Real IO, overridable per-call for tests (repo pattern: devtools actions.js).
const defaultDeps = {
  readCtx: (tabId) => runInTab(tabId, readCurrentContext),
  getJson: fetchJson,
  patch: apiPatch,
  reloadTab: (tabId) => chrome.tabs.reload(tabId),
  closePopup: () => window.close(),
  now: () => Date.now(),
};

// Detects the "another user holds this annotation in reviewing" state.
// Returns null in EVERY other case (no annotation, not reviewing, held by me,
// any failed read) — the banner must never guess. Holder name and staleness
// are best-effort embellishments: their reads failing degrades the result,
// never hides it.
export async function probeLock(tabId, deps) {
  const d = { ...defaultDeps, ...deps };
  const ctx = await d.readCtx(tabId);
  if (!ctx || !ctx.token || !ctx.domain || !ctx.annotationId) return null;

  let ann;
  let me;
  try {
    ann = await d.getJson(
      `${ctx.domain}/api/v1/annotations/${ctx.annotationId}?fields=status,modifier,modified_by,queue,assigned_at`,
      ctx.token,
    );
    if (!ann || ann.status !== 'reviewing') return null;
    me = await d.getJson(`${ctx.domain}/api/v1/auth/user`, ctx.token);
  } catch {
    return null;
  }
  if (!isLockedByOther({ status: ann.status, modifiedBy: ann.modified_by, meUrl: me && me.url })) {
    return null;
  }

  let holderName = 'another user';
  const holderId = extractIdFromUrl(ann.modified_by);
  if (holderId) {
    try {
      holderName = pickHolderName(
        await d.getJson(
          `${ctx.domain}/api/v1/users/${holderId}?fields=username,first_name,last_name`,
          ctx.token,
        ),
      );
    } catch {
      // keep the generic fallback
    }
  }

  let staleness = '';
  const queueId = extractIdFromUrl(ann.queue);
  if (queueId && ann.assigned_at) {
    try {
      const q = await d.getJson(
        `${ctx.domain}/api/v1/queues/${queueId}?fields=session_timeout`,
        ctx.token,
      );
      staleness = stalenessLabel(ann.assigned_at, q && q.session_timeout, d.now());
    } catch {
      // no staleness line
    }
  }

  return { ctx, holderName, staleness };
}

export default function ReviewingLockBanner({ tab, deps }) {
  const d = { ...defaultDeps, ...deps };
  const [lock, setLock] = useState(null);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    probeLock(tab.id, d)
      .then((res) => {
        if (!cancelled && res) setLock(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!lock) return null;

  const onRelease = async () => {
    setError(null);
    setReleasing(true);
    try {
      await d.patch(
        `${lock.ctx.domain}/api/v1/annotations/${lock.ctx.annotationId}`,
        lock.ctx.token,
        { status: 'to_review' },
      );
      d.reloadTab(tab.id);
      d.closePopup();
    } catch (e) {
      const msg = String((e && e.message) || e);
      setError(
        msg.includes('403')
          ? "You don't have permission to release this document."
          : msg.includes('401')
            ? 'Sign in to Rossum in this tab first.'
            : "Couldn't release the document — try again.",
      );
      setReleasing(false);
    }
  };

  return (
    <div class="reviewing-lock-banner" role="alert">
      <div class="rlb-head">
        <span class="rlb-icon" aria-hidden="true">🔒</span>
        <div class="rlb-text">
          <span class="rlb-title">Being reviewed by {lock.holderName}</span>
          <span class="rlb-sub">You have this document open read-only.</span>
          {lock.staleness ? <span class="rlb-staleness">{lock.staleness}</span> : null}
        </div>
        <button class="rlb-release" onClick={onRelease} disabled={releasing}>
          {releasing ? 'Releasing…' : 'Return to “To Review”'}
        </button>
      </div>
      <p class="rlb-caption">
        Ends their review session {'—'} any unsaved edits of theirs are lost, as if it
        timed out. No re-extraction.
      </p>
      {error ? <p class="rlb-error" role="alert">{error}</p> : null}
    </div>
  );
}
```

Note the JSX-unicode rule in action: `…`/`“ ”`/`—` appear only inside JS string
expressions (`{'—'}`, `'Releasing…'`), never as raw `\uXXXX` in JSX text. All three
error strings use straight apostrophes, exactly as in the Global Constraints copy
table — keep tests and implementation byte-identical to that table.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/popup-reviewing-lock-banner.test.js`
Expected: PASS (6 probeLock tests + 5 component tests). No commit.

---

### Task 4: Mount in `App.jsx` + styles + build

**Files:**
- Modify: `src/popup/components/App.jsx` (import block, lines 1–7; `#mainContent` open, line 235)
- Modify: `src/popup/popup.css` (`:root` block line ~11; dark override line ~31; new rules appended)
- Test: existing suite (no new file — the mount is two lines; behavior is covered by Task 3)

**Interfaces:**
- Consumes: Task 3 default export.
- Produces: the user-visible feature.

- [ ] **Step 1: Mount the banner**

In `src/popup/components/App.jsx`, add to the imports:

```jsx
import ReviewingLockBanner from './ReviewingLockBanner.jsx';
```

Then change the `#mainContent` opening (currently `<div id="mainContent">` followed by `<div class="content-row">`) to:

```jsx
        <div id="mainContent">
          {site === 'rossum' ? <ReviewingLockBanner tab={tab} /> : null}
          <div class="content-row">
```

- [ ] **Step 2: Add the styles**

In `src/popup/popup.css`, add to the light `:root` block (after `--accent-dim: #3560c0;`):

```css
  --warning-fg: #9a5b00;
  --warning-bg: rgba(217, 119, 6, 0.08);
  --warning-border: rgba(217, 119, 6, 0.35);
```

Add to the dark `:root` override (after `--accent-dim: #4a78e0;`):

```css
    --warning-fg: #f0b429;
    --warning-bg: rgba(240, 160, 75, 0.10);
    --warning-border: rgba(240, 160, 75, 0.40);
```

Append at the end of the file:

```css
/* ── Reviewing-lock banner (annotation held by another user) ── */
.reviewing-lock-banner {
  margin: 10px 12px 0;
  padding: 10px 12px 8px;
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius);
}

.rlb-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.rlb-icon {
  font-size: 14px;
  line-height: 1.35;
}

.rlb-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.rlb-title {
  font-weight: 600;
  color: var(--text-primary);
}

.rlb-sub {
  font-size: 12px;
  color: var(--text-secondary);
}

.rlb-staleness {
  font-size: 11px;
  color: var(--text-hint);
}

.rlb-release {
  flex-shrink: 0;
  align-self: center;
  padding: 5px 10px;
  border: 1px solid var(--warning-border);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--warning-fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.rlb-release:hover:not(:disabled) {
  border-color: var(--warning-fg);
}

.rlb-release:disabled {
  opacity: 0.6;
  cursor: default;
}

.rlb-caption {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-hint);
}

.rlb-error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--warning-fg);
  font-weight: 600;
}
```

- [ ] **Step 3: Run the full suite + build**

Run: `npm test`
Expected: all files PASS (including the three new test files).

Run: `npm run build`
Expected: clean esbuild output into `dist/` with no errors.

- [ ] **Step 4: Visual sanity (no commit)**

Load/reload the unpacked `dist/` extension, open any Rossum annotation, open the
popup: no banner (not locked) and no console errors. Full two-user verification is
Task 5.

---

### Task 5: Verification, docs, single commit

**Files:**
- Modify: `CLAUDE.md` (Popup section + Key Patterns)
- Commit: everything from Tasks 1–4 + the spec + this plan, as ONE commit

- [ ] **Step 1: Manual two-user dogfood on elis (internal org only)**

The verified recipe (memory: `reference_extension_dogfood_agent_browser`, and the
lock facts in `reference_rossum_annotation_reviewing_lock`): have a second account
(or the session-throwaway-user method from the spec work) `POST /annotations/{id}/start`
a test annotation in the internal test queue, then as yourself open that annotation
in the Rossum UI (it opens read-only) and open the popup. Verify:

1. Banner appears with the holder's name and a staleness line.
2. Click `Return to “To Review”` → the tab reloads, the annotation is `to_review`,
   and opening it now grants editing (you hold the lock).
3. Re-lock with the second account, revoke your own queue access is NOT needed —
   instead verify the 403 path by clicking release as a user without queue rights
   only if such an account is at hand; otherwise skip (the path is unit-tested).
4. Clean up: return the test annotation to `to_review`, deactivate any throwaway user.

- [ ] **Step 2: Document in CLAUDE.md**

In the **Popup** section of `CLAUDE.md`, append:

```markdown
The popup also self-detects (Rossum context, annotation URLs only) when the open
annotation is held in `reviewing` by ANOTHER user — `status === 'reviewing' &&
modified_by !== me`, live-verified: `POST /start` on a held annotation 409s
(`conflict_user`), so the viewer is genuinely stuck read-only — and shows a warning
banner (`ReviewingLockBanner.jsx` + pure `reviewingLock.js`) naming the holder plus a
staleness hint (`now − assigned_at` vs the queue's `session_timeout`). Its one-click
"Return to 'To Review'" force-release is `PATCH /annotations/{id} {status:'to_review'}`
— the ONLY non-holder-capable release (`/cancel` 409s for non-holders; patching
`queue` to itself is a no-op); it triggers NO re-extraction and to the holder is
indistinguishable from a normal session timeout (in-flight edit lost, saved edits
kept). On success the popup reloads the Rossum tab. No storage keys, no toggle
(always on), degrades to rendering nothing on any failed read. Spec:
`docs/superpowers/specs/2026-07-16-popup-unlock-reviewing-annotation-design.md`.
```

- [ ] **Step 3: Full suite + build one last time**

Run: `npm test && npm run build`
Expected: PASS + clean build.

- [ ] **Step 4: The single commit for the whole run**

```bash
git add src/popup/reviewingLock.js src/popup/mdh-provenance.js \
  src/popup/components/ReviewingLockBanner.jsx src/popup/components/App.jsx \
  src/popup/popup.css tests/popup-reviewing-lock.test.js \
  tests/popup-api-patch.test.js tests/popup-reviewing-lock-banner.test.js \
  CLAUDE.md docs/superpowers/specs/2026-07-16-popup-unlock-reviewing-annotation-design.md \
  docs/superpowers/plans/2026-07-16-popup-unlock-reviewing-annotation.md
git commit -m "feat: popup warning + one-click release for annotations locked by another reviewer"
```

(No `Co-Authored-By` trailer — owner rule. Remind the user to reload the extension:
`dist/` is what the browser runs.)
