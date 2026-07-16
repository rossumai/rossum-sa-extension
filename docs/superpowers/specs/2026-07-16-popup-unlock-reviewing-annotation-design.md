# Popup — "Someone else has this open" warning + force-release — design

**Date:** 2026-07-16
**Status:** designed; awaiting spec review → implementation. All backend/frontend
facts below were **live-verified on elis** (internal org) 2026-07-16 — no assumptions.
**Surface:** the extension **popup** (`src/popup/`), Rossum context only. Additive;
no manifest/permission/storage changes.
**Owner constraints honored:** decisions grounded in verified facts; backward
compatible; never leak customer names/data (this spec is name-free; the feature
shows a same-org colleague's name only inside the viewer's own popup).

## 1. Purpose

When a solution architect opens a Rossum annotation that **another user is
actively reviewing**, the backend blocks them and the Rossum UI drops them into a
read-only view **without saying who** holds it or offering a way out. This feature
adds, in the popup's top section, a banner that (a) names the reviewer and (b) offers
a **one-click force-release** that returns the document to *To Review* — the only
non-holder-capable release — so the SA can then take it over. No re-extraction.

## 2. Scenario & trigger (verified)

A document is read-only "because someone else has it open" **iff**:

```
annotation.status === 'reviewing'  &&  annotation.modified_by !== <current user URL>
```

Verified: `POST /annotations/{id}/start` on an annotation already held by another
user is **hard-refused** with:

```
HTTP 409  {"detail":"Document is being annotated by other user.","code":"conflict_user"}
```

— for **both** roles (admin blocked by an annotator's lock and vice-versa), with or
without the frontend's `{statuses:[…,'reviewing']}` payload. So an actively-held
lock **cannot** be stolen; the opener is genuinely stuck read-only. (A takeover only
happens *after* the holder leaves / the lock expires, when the next `start`
succeeds.) This is exactly the scenario the feature targets.

## 3. Verified backend grounding (facts, not assumptions)

Live-probed on elis (internal org, throwaway test annotation + a disposable
annotator user; all artifacts cleaned up):

- **Lock = `status === 'reviewing'`.** `start` sets it and changes nothing else.
- **`restricted_access` is NOT the lock** — it stayed `false` throughout a reviewing
  session; it is a separate access-restriction concept. **`assignees` is unrelated**
  too (stayed `[]`).
- **Holder identity = `modifier` / `modified_by`.** After a different user started,
  both fields became *that* user's URL. Reliable. (Fallback: if a hook modified the
  annotation mid-review the value could be a service account → show "another user".)
- **Force-release matrix:**
  | Mechanism | Result |
  |---|---|
  | `POST /annotations/{id}/cancel` (non-holder) | ❌ 409 `conflict_user` (holder-only) |
  | `PATCH /annotations/{id}` `{queue: <same>}` | ❌ no-op |
  | **`PATCH /annotations/{id}` `{status:"to_review"}`** | ✅ **200** |
  The status PATCH **releases the lock, works for any queue member (even a non-admin
  annotator), triggers no re-extraction (`rir_poll_id` + content SHA identical), and
  loses no saved data.** It is the *same* transition the server performs on
  `session_timeout` expiry and keeps the document in the **same queue**.
- **`session_timeout` is a QUEUE field** (`GET /queues/{id}` → e.g. `"01:00:00"`),
  server-side only ("time before annotation returns from Reviewing to To review").
  Usable as a **staleness** signal: `now − assigned_at` vs the queue timeout.
- Current-user URL for the comparison: `GET /api/v1/auth/user`.

## 4. Verified frontend behavior (elis-frontend; informs safety framing)

- Read-only-because-reviewing is the `start`→409→`displayAnnotation` fallback
  (`redux/modules/annotation/epics.ts:989-1016`, `helpers.ts:134-143`) — **not** in
  `resolveNoAccessReason.ts` (that only covers restrictedAccess/deleted/importing/
  failedImport).
- The evicted holder is kicked out either by (a) their next `/content/validate`
  autosave returning 409 (`lib/api.ts:128-143`) or (b) a hardcoded **5-minute** poll
  `timer(300000,300000)` seeing `status !== 'reviewing'` → `annotationExpired`
  (`epics.ts:951-978`). Result: embedded → `/timeExpired` blocking screen + token
  cleared; non-embedded → bounced to the document list + toast *"Your time for
  document annotation has ran out."*
- **The holder's in-flight unsaved edit is lost (no flush); previously-saved edits
  persist.** i.e. our force-release has the **same data profile as a normal session
  timeout** — not a new risk class.

## 5. Decisions (owner-approved 2026-07-16)

1. **Goal = variant (a):** "you're stuck read-only; here's *who* + a release button."
2. **Force-release primitive = `PATCH {status:"to_review"}`** (the only non-holder
   release; `cancel` 409s, move-to-same-queue is a no-op).
3. **One-click, no confirmation modal.** The banner button itself is the deliberate
   action. Because there is no modal, the button carries a clear label + a small
   static caption stating the consequence (see §7) so it stays *informed* but
   frictionless — reconciling the one-click choice with "never lose customer data".
4. **After success → reload the Rossum tab** so the SA's frontend re-fetches; the doc
   is now `to_review`, so their next open succeeds and they can edit.
5. **Show the holder's name** ("First Last (username)"), fallback "another user".
6. **Staleness line shown** in the banner (display-only, not a gate) — reviewable.

## 6. Detection flow (popup)

Runs like `MdhProvenancePanel` (async, non-blocking, silent on any failure):

1. `runInTab(tab.id, readCurrentContext)` → `{token, domain, annotationId}`.
   No `annotationId` / no token → render nothing.
2. `GET {domain}/api/v1/annotations/{annotationId}?fields=status,modifier,modified_by,queue,assigned_at`.
3. `GET {domain}/api/v1/auth/user` → current user `url` (cached per popup open).
4. If **not** (`status==='reviewing' && modified_by !== me.url`) → render nothing.
5. Resolve holder: `GET {domain}/api/v1/users/{modifierId}?fields=username,first_name,last_name`
   → "First Last (username)" (else `username`, else "another user").
6. Staleness: `GET {domain}/api/v1/queues/{queueId}?fields=session_timeout`; compute
   `age = now − assigned_at`; classify **active** (`age < timeout`) vs **likely
   expired** (`age ≥ timeout`) → drives the caption text only.

All reads reuse the existing `fetchJson(url, token)` helper (`src/popup/mdh-provenance.js`).

## 7. UI — banner in the popup top section

Rendered at the **top of the main content area** (directly under the header, above
the MDH/toggles row), Rossum context only, only when §6 fires. Full-width, warning-styled.

```
┌───────────────────────────────────────────────────────────┐
│ 🔒  Being reviewed by {First Last (username)}               │
│     You have this document open read-only.                  │
│     In review for ~12 min · lock expires after 1h           │  ← or: "review session looks expired"
│                                    [ Return to “To Review” ] │
│     Ends their review session — any unsaved edits of theirs  │  ← static caption (informed one-click)
│     are lost, as if it timed out. No re-extraction.          │
└───────────────────────────────────────────────────────────┘
```

- Button label: **Return to "To Review"** (not "unlock" — names the real effect).
- One click → §8. While the PATCH is in flight the button shows a busy/disabled state.

## 8. Force-release action

1. `PATCH {domain}/api/v1/annotations/{annotationId}` body `{"status":"to_review"}`,
   `Authorization: token <token>` (new tiny `apiPatch` helper; the popup currently
   only GETs).
2. **200** → `chrome.tabs.reload(tab.id)` then `window.close()` (mirrors the existing
   `onReloadTab` pattern in `App.jsx`).
3. **403** → inline banner error "You don't have permission to release this document."
4. **401** → "Sign in to Rossum in this tab first." (reuse existing auth-error copy.)
5. Other/network → inline "Couldn't release the document — try again." Banner stays.

## 9. Components & files

- **`src/popup/reviewingLock.js`** — pure helpers: `isLockedByOther({status, modifiedBy, meUrl})`,
  `pickHolderName(user)`, `stalenessLabel(assignedAt, sessionTimeout, now)`,
  `parseHmsToMs(str)`. Unit-tested (`tests/`), DOM-free.
- **`src/popup/components/ReviewingLockBanner.jsx`** — the async loader + banner UI,
  taking `{tab}`; owns its fetch lifecycle + `cancelled` guard (like `MdhProvenancePanel`).
- **`src/popup/mdh-provenance.js`** — add a minimal `apiPatch(url, token, body)`
  (or generalize `fetchJson`) for the single write.
- **`src/popup/components/App.jsx`** — mount `<ReviewingLockBanner tab={tab} />` at the
  top of `#mainContent` when `site === 'rossum'`.
- **`src/popup/popup.css`** — banner styles (reuse `--warning*` variables).

## 10. Backward compatibility & privacy

- Purely additive popup UI; **no** new storage keys, **no** manifest or
  `host_permissions` changes (reuses the page token + existing origins), **no** change
  to any existing toggle/feature. Degrades silently (renders nothing) when not on an
  annotation, not locked-by-other, or any read fails.
- The **only** write is the single opt-in `PATCH status=to_review`, and only on an
  explicit button click. No content is persisted or sent anywhere else.
- Privacy: the holder's name is shown solely inside the viewer's own popup (a same-org
  authorized admin), which is strictly less exposure than the data already sideloaded
  by the product. This spec, tests, and any memory stay name-free (generic placeholders).

## 11. Testing

- Unit (Vitest, `.test.js` via `h(...)` per repo convention): `reviewingLock.js`
  helpers — trigger predicate (reviewing+other=true; reviewing+self=false; non-reviewing=false;
  unresolved modifier→"another user"), `parseHmsToMs`, `stalenessLabel` boundaries.
- Component: `ReviewingLockBanner` renders nothing when not applicable; renders banner
  + button when locked-by-other; PATCH-success path calls `chrome.tabs.reload`; 403/401
  render inline errors (mock `fetch`/`chrome`).
- Manual dogfood on elis (two accounts, or the throwaway-user method) per
  `reference_extension_dogfood_agent_browser`: confirm banner shows the holder, the
  release returns the doc to To Review, the tab reloads, and the SA can then open/edit.
- `npm run build` then reload the extension (dist is what the browser runs).

## 12. Out of scope

- Variant (b) ("surface concurrent reviewing in either direction"), any takeover-warning
  when *we* evict someone by opening, and any change to Console/Inspector.
- Editing `restricted_access`, assignees, or queue membership.
- Reading/altering the queue's `session_timeout` (display-only use of its value).
- Any confirmation modal (explicitly declined — one-click).

## Revision v2 (2026-07-16, owner-picked from the 3-design proposal)

After shipping v1 (`e8a436e`), three redesign directions were proposed in a browser
artifact; the owner chose **variant C ("two-beat unlock") reduced to one step**:

- **Layout:** SVG lock icon in a `--bg-card` squircle · text column · button. The
  full-amber wash stays, but the banner is two short lines — no fine print.
- **Copy:** title `Document locked by {plain name}` (v2.2 wording; first+last, else username, else
  "another user" — the `(username)` suffix was dropped), sub `Read-only while they
  review`, button `Unlock` (busy `Unlocking…`). Error strings unchanged.
- **Removed by owner decision:** the time/staleness line ("12 min of 1 h") and the
  standing consequence caption; **no confirmation step** (one click unlocks).
- **Code consequence:** the queue `session_timeout` fetch and the
  `parseHmsToMs`/`formatDuration`/`stalenessLabel` helpers became dead code and were
  deleted; the annotation probe now requests only `?fields=status,modified_by`.
  §6 steps 5b (staleness) and the §7 caption/staleness rows are superseded
  accordingly; everything else in this spec stands.

### v2.1 (2026-07-16): banner moved to the BOTTOM of `#mainContent`

The probe's API calls resolve after first paint, so a top-mounted banner pushed the
whole popup down when it appeared (layout shift). Chrome popups are top-anchored:
an element appearing at the bottom only grows the window downward. The banner now
renders after `.content-row` (above the footer); §7's "top of the main content
area" is superseded.
