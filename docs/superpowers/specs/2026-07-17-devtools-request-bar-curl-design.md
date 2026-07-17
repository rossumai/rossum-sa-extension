# DevTools "Rossum" panel — Rossum-aware request bar + Copy as curl

**Date:** 2026-07-17
**Status:** Design (approved in brainstorming; not yet implemented).
**Builds on:** `2026-07-10-devtools-rossum-panel-design.md` (the Raw Object Editor — the authoritative current panel design). This spec is additive; it changes no existing contract.

## Problem & goal

The DevTools "Rossum" panel today is a resource **browser + editor**: it reads the inspected page, GETs the backing API resource, renders JSON, lets you navigate to **related** resources by Cmd/Ctrl-clicking API URLs already present in the JSON, and edits a top-level key via a confirmed PATCH. The one thing that makes it *feel* like Postman — reaching an arbitrary endpoint and inspecting the response — is only half there: you can only land on resources the current page links to. "A paste-a-URL explorer" was explicitly listed as *out of scope* in the panel design.

The Rossum API is a **known, structured** surface. A dumb URL box would make the SA already know the endpoint they want; a **Rossum-aware** bar flips that — the extension knows what's valid and teaches the SA who hasn't memorized the API. That is squarely on-mission for onboarding SAs.

**Goal:** add (1) a **Rossum-aware, GET-only request bar** that lets an SA reach *any* endpoint — guided by autocomplete over a curated endpoint catalog — and (2) **Copy as curl** to hand off, reproduce, or document a call.

## Non-goals (this iteration)

- **No non-GET issuing from the bar.** Editing a fetched resource continues through the *existing* PATCH diff→confirm flow, unchanged. The bar issues reads only, so it adds no new arbitrary-write surface and stays clear of the read-only ship-blocker. (A method dropdown is a documented future extension.)
- **No param-builder UI** (chips/fields that assemble the query string). The SA types the `?query=…` themselves; the catalog *teaches* the params in the autocomplete description line (see §4). Deferred; the catalog data is shaped to support it later.
- **No request history / saved requests / "collections."** Omnibox only → nothing is persisted.
- **No browse palette or contextual "related to this page" panel.** Deferred.
- **No HTTPie / prd2 / fetch export.** curl only.

## Principles

- **Additive & reuse-first.** A bar-issued GET becomes a tab through the *same* machinery a Cmd/click uses (`resourceFromApiUrl` → `openResourceTab`), inheriting the JSON editor, name hints, content preview, read-only handling, and diff→confirm PATCH for free.
- **Correctness over guessing.** Awareness comes from a curated catalog (same ethos as `detect.js`), not heuristics. Unknown paths are *warned but still allowed* (power tool; the catalog may lag the live API).
- **Nothing sensitive at rest.** No new persisted state. The live auth token reaches the clipboard *only* on an explicit, warned "Copy with live token" action; the default curl is redacted.

## Feature 1 — the request bar

### 1a. Placement & interaction

A slim, **always-visible input above the tab bar** (matches the approved mockup). A static `GET` affordance on the left (no method dropdown in v1). Typing opens an autocomplete dropdown; **Enter** or a **→ (Go)** button fires; **Cmd/Ctrl+L** focuses the bar. That is the entire surface — deliberately lean.

### 1b. Input parsing & normalization — `requestInput.js` (pure, new)

`normalizeRequestInput(raw, currentDomain) → { apiPath, warning? } | { error }`

Accepts and normalizes to a leading-slash `apiPath` (query preserved):

- a **full URL of the current org only** — `https://elis.rossum.app/api/v1/queues/123?x=1`
- `/api/v1/queues/123`
- `/queues/123` (missing `/api/v1` prefix auto-prepended)
- bare `queues` or `queues?page_size=100`
- `annotations?queue=123&status=to_review`

Rules: strip the current domain; auto-prepend `/api/v1` when absent; preserve the query string verbatim; **reject a different host** (returns `{error}` with an advisory message — the bar refuses to fire cross-org). Empty/whitespace → no-op.

### 1c. Endpoint catalog & autocomplete — `catalog.js` (pure, new)

A curated list of the SA-relevant API surface. Each entry:

```
{ collection, kind: 'list' | 'detail' | 'sub', pathTemplate, label, description }
```

- `pathTemplate` uses `{id}` placeholders (e.g. `/annotations/{id}/content`).
- `description` is one line that **names the key params/sideload inline**, so the omnibox teaches "how it works" without a builder UI — e.g. *"annotations — list · filters: queue, status, document · sideload: document, modifier · ordering"*.

**Coverage (curated, extensible):** queues, schemas, hooks (+ `hooks/logs`), engines, rules (+ rule execution logs), annotations (+ `/{id}/content`, `/{id}/content/{datapointId}`), documents (+ `/{id}/content` file), pages, relations, workspaces, organizations, organization_groups (read-only), users, groups, connectors, email_templates, emails, email threads, inboxes, workflows / workflow_steps / workflow_runs / workflow_activities, audit_logs, tasks, whoami. New entries are one row each.

**Autocomplete behavior:**

- `suggest(input) → ranked entries` — fuzzy match over `collection` + `label` + `pathTemplate`. Keyboard-navigable (↑/↓/Enter/Esc); picking one inserts its `pathTemplate` with the cursor on the first `{id}`.
- **Validation:** if the typed path's leading collection isn't in the catalog, show an advisory "not a known Rossum endpoint" chip — **but firing is still allowed** (the catalog can lag the API; this is a power tool, not a gate).
- **Optional live seed (behind a live-verify gate):** on first focus, `GET /api/v1/` (the DRF API root) to enumerate the org's collections and merge names into the suggestion set — curated descriptions win; live-only collections show a generic label. Graceful fallback: if the root 403s or isn't a browsable map, the curated catalog stands alone. *This must be verified live before implementation; it is an enhancement, not a dependency.*

### 1d. Firing a request → tab — extend `resourceFromApiUrl.js`; `openRequestPath` in `actions.js`

- **Single known resource** (`…/collection/{id}` with optional known sub-path) → the existing `resourceFromApiUrl` descriptor → `openResourceTab` (editable iff the resource is editable — identical to link-nav).
- **List / query / unknown path** (bare collection, or any path carrying a query string, or a collection not in the descriptor map) → a **generic read-only descriptor**: GET via `api.getResource` (JSON → editor, read-only; blob → `PreviewPane`). Label derived from the path (e.g. `queues?page_size=100`, truncated). `keyOf` uses the **full apiPath including the query string**, so distinct queries open as distinct tabs (rather than deduping onto the bare collection).
- The bar **never hard-fails**: any reachable path opens a tab; transport errors surface in the tab's existing error slot (401/403/404 handled exactly as today).

## Feature 2 — Copy as curl

### 2a. `curl.js` (pure, new)

`buildCurl({ domain, apiPath, token }) → string`

- `token` **null/omitted → redacted**: `curl -H 'Authorization: Token $ROSSUM_TOKEN' '<domain><apiPath>'` followed by a `# export ROSSUM_TOKEN=<your token>` hint line.
- `token` present → the same command with the real token inline (no hint line).
- URL is single-quoted (shell-safe); `Authorization: Token <…>` is Rossum's scheme; GET is the default (no `-X`).

### 2b. UI

A control in each tab's **footer** (beside Save / the read-only note) and in the **tab context menu**, offering two actions:

- **Copy as curl** → the redacted form (nothing sensitive on the clipboard).
- **Copy with live token ⚠** → the live form, followed by a transient "Live token copied — treat as a secret" toast.

Available on every tab (page-detected, link-opened, or bar-issued), since each is just an `apiPath` + the current `domain`/`token`.

## Files touched

New (all `src/devtools/`): `requestInput.js` (pure), `catalog.js` (pure), `curl.js` (pure), and a `RequestBar.jsx` component (bar + autocomplete dropdown).
Modified: `resourceFromApiUrl.js` (generic list/query/unknown descriptor), `actions.js` (`openRequestPath`), `panel.jsx` (mount the bar above the tab bar; wire Cmd/Ctrl+L; footer curl controls), `store.js` (bar input/suggestion signals as needed; a toast signal), `panel.css` (bar + dropdown + toast + footer control styles, theme-aware).

## Error handling, read-only, data

- 401/403/404 and read-only fallback: unchanged from the panel design.
- Bar-issued list/query/unknown tabs are **read-only** (a list response is not PATCH-able).
- **Nothing persisted** (omnibox-only → no history/saved requests). The token is never stored; the live-token curl reaches the clipboard only on the explicit warned action. No customer data leaves the browser.

## Testing

- **Pure/unit (Vitest):** `requestInput` (each accepted form; cross-host reject; `/api/v1` auto-prefix; query preserved), `catalog` (fuzzy ranking; validation flags unknown but does not block; template `{id}` insertion), `curl` (redacted vs live; single-quoting; hint line only when redacted), and the extended `resourceFromApiUrl` (generic list/query descriptor + `keyOf` distinctness incl. query).
- **Partial UI:** autocomplete render + keyboard nav; footer copy actions with a mocked clipboard.
- **Dogfood (not unit-testable):** the live DRF-root seed, real clipboard/toast, autocomplete feel, real Cmd/Ctrl+L focus.

## Live-verify gates (before non-dogfood use)

1. **DRF API root** — confirm `GET /api/v1/` returns a browsable collection map on a dev org; if not, ship the curated catalog alone (the seed degrades gracefully).
2. **Generic GET tabs** — confirm list/query responses render correctly read-only (JSON) and that binary sub-resources still route to `PreviewPane` via `getResource`'s content-type branch.

## Out of scope / future (catalog data already shaped for these)

Param-builder chips · browse palette · contextual "related to this page" suggestions · request history / saved "collections" · non-GET methods (behind a future gate once the write-lock is resolved) · HTTPie / prd2 / fetch export · copy-as-curl of the *composed* bar request before opening it.

## Revision — iteration 2 (2026-07-17): bottom command bar + assumed prefix + floating Save pill

Post-ship UX refinement (owner-directed, mockups iterated in-browser):

- **Assume `/api/v1/`.** The prefix is constant, so it is never typed: shown as a dimmed, non-editable adornment in the bar; the input, autocomplete, and inserted values are all prefix-free. New pure helpers in `catalog.js` — `relPath` (robustly strips a full/partial/host-qualified `/api/v1/` prefix; a partially-typed prefix like `/api/v1` resolves to `''`) and `shortPath` (template minus the prefix). `suggest` now matches on the short form and, when the term is empty (mid-prefix), returns the common endpoints instead of `[]` — fixing the "typing v1 blanks the suggestions" dead spot.
- **Input moved to a bottom command bar** (`.rawjson-bottombar`): `GET /api/v1/ [input] →` on the left, the copy control on the right. Autocomplete opens **upward**.
- **Save is a floating pill** over the JSON editor (`.rawjson-savepill`), shown only while the buffer is dirty, with an "N unsaved changes" count (`diff.js buildPatchBody`) and a **Save…** button that opens the unchanged diff→confirm→PATCH→reload. Save-only (no Revert, per owner). Save is no longer in the bottom bar, so navigation and saving never share a row. Read-only/preview tabs show no pill.
- **Copy redesigned as a split-button** in the bottom bar: main = redacted `curl`, caret = an upward menu (`store.curlMenu`) with "Copy with live token". Removed from the tab context menu and the old footer (the footer is gone).
- Behavior otherwise unchanged: GET-only issuing, token-security (redacted default), nothing new persisted, `store.toast` auto-dismiss.
