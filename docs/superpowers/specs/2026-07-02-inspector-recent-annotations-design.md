# Inspector — recent-annotations shortcuts

- **Date:** 2026-07-02
- **Status:** Design approved
- **Scope:** Console → Inspector app, the annotation search input (landing states)
- **Audience:** Internal / dogfood (Rossum SAs)

---

## 1. Problem & intent

The Inspector requires an annotation id (or Rossum URL) every time. SAs re-inspect the
same handful of annotations repeatedly and must re-paste each id. Intent: **remember the
most recently inspected annotations and offer them under the search input** so they can be
re-opened in one click.

## 2. Approved decisions

- **Display:** landing-state only — the recents list renders in the two "no annotation
  loaded yet" views (the `connected === false` empty view and the connected-but-no-`data`
  view). It is hidden once a report is open.
- **Persistence:** `chrome.storage.local` key **`inspectorRecents`** — cross-session and
  shared across Console tabs (matches the codebase's cross-session state convention).
  Async load on Inspector init; guarded for non-extension/test contexts.
- **Entry detail (rich):** each entry stores `{ id, fileName, queue, status, at }`.
  These are persisted only in the SA's own local browser storage (no token, no content) —
  analogous to browser history of the Rossum URLs they visited.

## 3. Data model

A recent entry: `{ id: string, fileName: string|null, queue: string|null, status: string|null, at: number }`.
The list is **deduped by `id`, most-recent-first, capped at 8** (`MAX_RECENTS`).

## 4. Architecture

- **`src/inspector/recents.js` (new):**
  - `MAX_RECENTS = 8`, storage key `inspectorRecents`.
  - `mergeRecent(list, entry, max = MAX_RECENTS)` — **pure**: drop any existing entry with
    the same `id`, unshift the new one, cap at `max`. Coerces `id` to string.
  - `loadRecents()` — async: read `chrome.storage.local` → set `store.recents.value`
    (guarded; no-op + leaves `[]` outside an extension context).
  - `recordRecent(entry)` — `mergeRecent` into `store.recents.value`, then fire-and-forget
    persist (guarded). No-op when `entry`/`entry.id` is nullish.
  - `clearRecents()` — set `store.recents.value = []` + remove the storage key (guarded).
- **`src/inspector/store.js`:** add `export const recents = signal([])`.
- **`src/inspector/index.jsx`:**
  - `initInspector` calls `loadRecents()` (fire-and-forget) at the top, before `whoami`, so
    recents populate even when the session probe fails (they show in the not-connected view).
  - `loadAnnotation` success branch, right after the staleness-guarded `store.data.value = …`,
    builds an entry from `annotation.id` / `resolved.document?.original_file_name` /
    `resolved.queue?.name` / `annotation.status` and calls `recordRecent`. Only the winning
    (non-stale) load records; failed loads (bad id) never record.
- **`src/inspector/components/RecentAnnotations.jsx` (new):** reads `store.recents.value`;
  renders nothing when empty; otherwise a "Recent" heading + a list of rows. Each row is a
  button showing `fileName` (or `#id` fallback) · queue · a small status chip · `#id`, and
  calls `onSelect(String(id))` on click. A subtle **Clear** link calls `clearRecents`.
- **`src/inspector/components/App.jsx`:** render `<RecentAnnotations onSelect={inspect} />`
  in the `connected === false` empty block (below the input) and in the connected view only
  when `!store.data.value` (landing). The existing `inspect(id)` = `setAnnotationId` +
  `loadAnnotation` path is reused verbatim.
- **`src/console/console.css`:** add `.inspector-recents*` / `.inspector-recent*` styles near
  the other `.inspector-*` rules.

## 5. Edge cases

- Missing `fileName` → the row shows `#id` as its primary label. Missing `queue`/`status` →
  that segment is omitted.
- Empty list → the component renders nothing (no empty "Recent" header).
- Re-inspecting an already-listed annotation moves it to the front (no duplicate); its
  metadata refreshes from the new load.
- Non-extension context (unit tests / node) → all storage access is `try`-guarded and the
  signal simply stays whatever it was set to in-memory.

## 6. Testing

- `recents.js` (pure + mocked `chrome.storage`): `mergeRecent` dedup-to-front, cap at max,
  newest-first, null-tolerant; `recordRecent` updates the signal + persists; `loadRecents`
  reads + sets the signal; `clearRecents` empties + removes.
- `RecentAnnotations` (component): renders rows for a populated signal; `#id` fallback when
  no filename; click calls `onSelect` with the id; empty signal → renders nothing.

## 7. Read-only / privacy posture

No writes to the customer org (the feature only reads already-loaded annotation metadata and
persists it locally). Filenames/queue names live only in the SA's local `chrome.storage.local`
— never sent anywhere, never the token or document content. `clearRecents` lets the SA wipe it.
