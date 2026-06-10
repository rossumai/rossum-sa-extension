# MDH — Surface index operation status via top banners

**Date:** 2026-06-10
**Status:** Approved (design), pending implementation
**Area:** Dataset Management (MDH) → Indexes + Search Indexes panels

## Problem

Async index/search-index operations are polled correctly (op id now read from the
`content-location` header) and the backend reports `FAILED` with a real
`error_message`. But the result is shown only in a bespoke op-status bar at the
**bottom** of the panel, which is *near-invisible* — users miss failures and
have no in-progress feedback ("silently waiting").

The Data tab already surfaces errors via a prominent **red stripe at the top**
(`<ErrorBanner>` in `App.jsx`, driven by the global `error` signal). The index
panels never set `error.value` for op failures — they only set the local
`opStatus`. **Reuse the top-stripe pattern.**

## Design

### New global signal + banner

- `store.js`: add `export const opNotice = signal(null)` — shape
  `{ message: string, kind: 'info' | 'warning' }`.
- New `src/mdh/components/OpNoticeBanner.jsx`: renders a full-width stripe from
  `opNotice.value` with a dismiss `×` (mirrors `ErrorBanner`); class by `kind`.
- `App.jsx`: mount `<OpNoticeBanner />` immediately after `<ErrorBanner />`
  (same top region, above `.main-content`).
- `console.css`: `.op-notice-banner` (info = accent tint) and
  `.op-notice-banner.warning` (warning tint), styled like `.error-banner`.

### `useOperationStatus` drives the global stripes

Replaces the local `opStatus` bottom bar. `track(opId, { label, onFinished })`:

| Poll outcome | Action |
|---|---|
| RUNNING (immediately) | `opNotice = { message: '<label>… (runs in the background)', kind: 'info' }` |
| FINISHED | clear `opNotice`; call `onFinished()` (re-list) |
| FAILED | clear `opNotice`; `error.value = { message: '<label> failed: <error_message>' }` (red stripe) |
| timeout / pollUnavailable | `opNotice = { message: '<label>: still running — use Refresh to confirm.', kind: 'warning' }` |

- Aborts the in-flight poll AND clears *its own* `opNotice` on unmount and on
  `clear()` (collection/panel switch). Only clears `opNotice` it set (owner flag),
  never touches `error.value` except to set it on FAILED.
- Drops the local `opStatus` state and the `recheck` action (the toolbar Refresh
  covers timeout recovery). Returns `{ track, clear }`.

### Panels

- `IndexPanel` / `SearchIndexPanel`: pass a label to `track`
  (`Creating search index "<name>"`, `Dropping index "<name>"`, etc.) and
  **remove the bottom op-status bar JSX**.
- create uses the parsed `indexName`; drop uses the `indexName` argument.

### Out of scope

- `Sidebar` collection-drop already routes failures to `error.value` (red stripe)
  and shows the loading overlay during the (fast) drop — unchanged.

## Testing

- `tests/mdh-operation-status.test.js` (rewritten): `track` sets `opNotice`
  (info); resolve → `opNotice` cleared + `onFinished` called; reject → `error.value`
  set (with label + message) and `opNotice` cleared; timedOut/pollUnavailable →
  `opNotice` warning; a superseding `track` and unmount/`clear()` clear `opNotice`
  and a late resolve can't clobber.
- `tests/mdh-op-notice-banner.test.js` (new): renders nothing when `opNotice` is
  null; renders the message + a working dismiss when set; applies the `kind` class.
- `tests/mdh-index-panel.test.js` (updated): a failed create sets `error.value`
  (no bottom bar); a running create sets `opNotice` and clears it on finish;
  collection switch clears `opNotice`.
- Full suite + `npm run build` green.
