# MDH — Surface async index operation failures

**Date:** 2026-06-10
**Status:** Approved (design), pending implementation
**Area:** Dataset Management (MDH) → Indexes + Search Indexes panels

## Problem

`createIndex` / `dropIndex` / `createSearchIndex` / `dropSearchIndex` are async:
the API returns `202` with an operation id in `res.message`. Today the panels
set the op-status bar to `running` and rely on a manual **"Check Status"** button
that does a *one-shot* `checkOperationStatus`. So a failed creation sits at
"running" until the user manually clicks — possibly repeatedly — before the
failure ever appears.

The machinery to fix this already exists: `api.waitForOperation(opId, {signal})`
(`api.js:237`) polls to a terminal state, **resolves on `FINISHED`** and
**throws the server `error_message` on `FAILED`** (or times out at 120s).
`Sidebar.jsx` already uses it for collection drop. The index panels don't.

## Decision

Extract a shared `useOperationStatus` hook that auto-polls via
`waitForOperation`, driving the existing op-status bar to `finished`/`failed`
automatically and showing the server error on failure. Applies to all four
async ops (create + drop) in both panels.

## Design

### New hook `src/mdh/hooks/useOperationStatus.js`

```js
import { useState, useRef, useEffect } from 'preact/hooks';
import * as api from '../api.js';

export default function useOperationStatus() {
  const [opStatus, setOpStatus] = useState(null); // { operationId, status, errorMessage }
  const abortRef = useRef(null);
  const lastRef = useRef(null);                    // { operationId, onFinished } for recheck

  useEffect(() => () => abortRef.current?.abort(), []); // cancel poll on unmount

  function track(operationId, { onFinished } = {}) {
    if (!operationId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastRef.current = { operationId, onFinished };
    setOpStatus({ operationId, status: 'RUNNING', errorMessage: null });
    api.waitForOperation(operationId, { signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        setOpStatus({ operationId, status: 'FINISHED', errorMessage: null });
        onFinished?.();
      })
      .catch((err) => {
        if (controller.signal.aborted) return;        // ignore our own abort
        setOpStatus({ operationId, status: 'FAILED', errorMessage: err.message });
      });
  }

  function recheck() {
    const last = lastRef.current;
    if (last) track(last.operationId, { onFinished: last.onFinished });
  }

  function clear() { abortRef.current?.abort(); setOpStatus(null); }

  return { opStatus, track, recheck, clear };
}
```

- A new `track` aborts the previous poll, so a late resolve from a superseded
  operation can't clobber the current state (guarded by `signal.aborted`).
- Unmount aborts the in-flight poll.

### `IndexPanel.jsx` + `SearchIndexPanel.jsx`

- Replace `const [opStatus, setOpStatus] = useState(null)` + the one-shot
  `checkStatus()` with `const { opStatus, track, recheck } = useOperationStatus()`.
- create/drop handlers: after `parseOperationId`, call
  `track(opId, { onFinished })`. **Remove the immediate post-202 re-list** — it
  ran before the op finished. `onFinished` does the reload, so a newly-created
  index appears only once it's actually built:
  - IndexPanel `onFinished = () => { loadIndexes(); loadStats(); }`
  - SearchIndexPanel `onFinished = loadSearchIndexes`
  - If `parseOperationId` returns null (no async op), fall back to an immediate reload.
- Keep `cache.invalidate(...)` before `track` so the `onFinished` reload refetches.
- Op-status bar: `running` (automatic — no button), `finished` (green),
  `failed` (red + `errorMessage`) with a single **"Re-check"** button shown only
  when not running (recovery after a timeout, where the op may since have
  finished). The old "Check Status" button is removed.

## Out of scope

- `Sidebar.jsx` collection drop already `await`s `waitForOperation` — unchanged.
- No new global error-banner bubbling; the op-status bar (existing red `failed`
  badge + message) is the surface.

## Corrections (post-implementation, verified live on a customer dev org)

- **Op id source:** the 202 response body `message` is **empty** on this Data
  Storage; the operation id (a UUID) is in the **`content-location` header**.
  `api.post()` now extracts it and exposes `res.operationId`; panels + Sidebar
  use `res.operationId` (not `parseOperationId(res.message)`). Without this,
  `track` was never called — the original silent-failure bug.
- **Timeout ≠ failure (review finding):** `waitForOperation` tags its 120s
  timeout error (`err.timedOut = true`); the hook maps it to a distinct
  `TIMEOUT` status rendered with the neutral/warning badge (not red `failed`).
  Re-check shows on `FAILED` **or** `TIMEOUT`.
- **Clear on collection switch (review finding):** both panels call the hook's
  `clear()` in their collection/panel `useEffect`, so an in-flight op from a
  previous collection can't surface its result (or mis-attributed reload) under
  another collection.
- **Backend caveat:** the backend (likely DocumentDB) is permissive — a
  2dsphere index over string data returned `FINISHED`. Surfacing a build failure
  depends on the backend reporting `FAILED` (e.g. unique-key violations); the
  extension now polls correctly, but cannot invent a failure the backend doesn't
  report.

## Testing

- `tests/mdh-operation-status.test.js` (hook, via a `setup()` render harness
  mirroring `mdh-editor-snapshot.test.js`; `vi.mock('../src/mdh/api.js')`):
  - `track` → `RUNNING` synchronously; `FINISHED` + `onFinished()` called once
    when `waitForOperation` resolves.
  - `track` → `FAILED` + `errorMessage` when `waitForOperation` rejects.
  - a second `track` aborts the first: a late resolve of the first poll does not
    overwrite the second's state.
  - unmount aborts (no state update after the poll resolves post-unmount).
- Extend `tests/mdh-index-panel.test.js`: a create whose `waitForOperation`
  rejects renders a `failed` op-status with the server message (and a Re-check
  control); a successful create triggers a re-list on finish.
- Full suite + `npm run build` green.
