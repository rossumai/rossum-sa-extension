# API call reduction and 429 handling — design

**Date:** 2026-10-13
**Status:** built 2026-10-13. §4.4 was updated to match two review rulings (the 5-minute backstop for a queue with no MDH hook, and the queue-only annotation check on the empty path).
**Scope:** new `src/net/rateLimit.ts`; `src/inspector/` (request scope, 429); `src/galaxy/`
(429); `src/popup/` (`cache.ts`, `mdh-provenance.ts`, `components/MdhProvenancePanel.tsx`).
One PR.

## 1. Why

A heavily customised org hit HTTP 429 from the Rossum API. The extension is probably a small
part of that org's traffic next to its own hooks and integrations, but it shares the user's
token, and its heaviest calls — full hook lists — are heaviest exactly on such orgs. An audit
of the extension's API calls (a handover written by an agent, not re-verified until this spec)
listed eight places that fetch the same data again. This design keeps the ones that reduce
request count or remove a misleading result, and adds what the audit missed: the extension has
no 429 handling for the Rossum API at all.

Goals, weighted equally by the owner: less pressure toward 429, repo hygiene, a quicker popup.

## 2. Facts this design rests on

### a. Code (verified on `d8b6e01`, `master`)

- **No 429 handling.** Only Fabry Chat names 429, and only for the agent API
  (`src/fabry/chat.ts:15`).
- **Inspector turns a 429 into "nothing there".** `safe()` (`src/inspector/index.tsx:13`)
  maps any error to `null`, and the loaders read `null` as `[]`. A rate-limited hooks list
  sets `_hooksLoaded: true` with no hooks — a false diagnosis.
- **Inspector lists hooks and rules more than once per annotation.** `index.tsx:73-75` starts
  `loadQueueHooks`, `loadLabelContext` and `loadQueueRules` together; `loadLabelContext` lists
  rules and hooks again (`:334-335`). `_hooksLoaded` / `_rulesLoaded` are set only on
  completion, so panels that mount mid-load call the loaders again (`PipelinePanel.tsx:11`,
  `ExportPanel.tsx:16`, `ProvenancePanel.tsx:44`, `LabelsPanel.tsx:49`), and on a queue with
  no hooks `attributionContext.ts:16` lists them once more.
- **Galaxy keeps paging after a 429.** `fetchOrgResources` (`src/galaxy/api.ts:139`) lists
  five collections in parallel, each paging sequentially. A 429 rejects `Promise.all`, but
  nothing aborts the other four loops, so they keep sending requests. Hooks arrive as full
  objects (function hooks include their code); `graph.ts` reads only `id`, `url`, `name`,
  `type`, `active`, `events`, `queues`, `run_after`, `description`.
- **Popup never caches an empty hook list.** `MdhProvenancePanel.tsx:183` caches only
  `if (hookEntries.length > 0)` — deliberately, so "no hooks" and "no hook applies" stay
  distinct. The empty-result return (`:197`) also runs before `setCachedAnnotation` (`:267`).
  On a review-screen URL (`/document/<id>`, no queue in it) every open of an empty queue sends
  the annotation GET (`:153`) and the full hooks GET (`mdh-provenance.ts:819`). Lookup-only
  queues send the hooks GET every open too.
- **Popup TTL then full refetch.** `cache.ts:4` trusts an entry for 5 minutes; after that an
  open refetches hooks, the queue and the full schema (`mdh-provenance.ts:340,343`).
- **The popup's `fetchJson` throws `new Error('HTTP <status>')`** with no `status` field
  (`mdh-provenance.ts:14`); the Inspector's and Galaxy's `apiError` carry `status`.

### b. Rossum API (public OpenAPI spec, read 2026-10-13; not tested live)

- Hook, queue, rule, schema and organization objects carry `modified_at`. Labels do not.
- List endpoints cannot be ordered by `modified_at`.
- `/schemas` accepts a `queue` filter; `/hooks` accepts `queue`.
- `fields=` is not documented on list endpoints. The repo uses it on detail routes and on the
  annotations list.

### c. Live probe (2026-10-13, read-only GETs with `curl` on a sandbox org)

1. **`fields=` is ignored on the `/hooks` list.** `?page_size=100` and
   `?page_size=100&fields=id,modified_at` returned the same 79,877 bytes of full hook objects
   (seven hooks, function-hook code included). It works on detail routes:
   `/queues/X?fields=schema,modified_at` returned 106 bytes. So no cheap per-hook
   `modified_at` check exists, and Galaxy cannot trim its hooks list.
2. **`/schemas?queue=X` filters and is small without `fields=`.** It returned one schema in
   372 bytes (`id`, `name`, `url`, `queues`, `metadata`, `modified_at`, `modified_by` — the
   list never carries `content`); an unknown queue id returned zero results.
3. **`/queues/X?fields=hooks,modified_at` lists the attached hooks** as URLs (251 bytes), the
   same four the `/hooks?queue=X` list returned. Attaching or detaching a hook changes it;
   editing a hook's settings does not.
4. **No rate-limit headers** on normal responses (no `X-RateLimit-*`). Whether a 429 carries
   `Retry-After` was not observed — none occurred, and none was provoked. §4.1 handles both.

## 3. Non-goals

Each was considered and dropped on 2026-10-13:

- **Popup lock banner and MDH card sharing one annotation GET** — one tiny GET per open at
  human pace; the shared plumbing (a host-owned scope passed by context) costs more than it
  saves.
- **Memoising "copy/open lookup query"** — user clicks, rare.
- **DevTools `resolveResource` using its 60 s cache** — one GET per tab load.
- **Inspector queue-level cache across annotations** — revalidation would keep the request
  count (about five per annotation) and save only bytes.
- **Sharing the Console's session probes** — each app probes once, on first activation; a
  later probe still has a purpose (the session may have expired).
- **Any automatic retry** of a 429.
- **A shared caching layer.** Storage stays per surface, because the contexts differ: the popup
  is destroyed on close (`chrome.storage.session`), a content script cannot read that
  (`sessionStorage`), the Console is a long-lived page (memory).
- **Moving `single()` out of `src/mdh/cache.ts`**, or touching `fetchRossumApi` /
  `fetchRossumApiFresh` in `src/rossum/api.ts`.

## 4. Design

### 4.1 `src/net/rateLimit.ts`

- `rateLimitError(resp, message)` → an `Error` with `status: 429` and `retryAfter`: the
  `Retry-After` header as whole seconds, or `null` when absent or not a number (an HTTP-date
  value reads as `null`).
- `isRateLimited(err)` → `err?.status === 429`.
- `rateLimitMessage(err)` → "Rossum is rate-limiting requests. Try again in N s." or, with no
  `retryAfter`, "Rossum is rate-limiting requests. Try again shortly."

Each transport in scope builds its 429 through `rateLimitError`: the popup's `fetchJson`,
`src/inspector/api.ts` `get`, `src/galaxy/api.ts` `get`. The popup's `fetchJson` also gains a
`status` field on every error (same message as today).

Rules everywhere in scope: never retry a 429 automatically; code that maps an error to "empty"
must not do so for a 429; Refresh (or reload) bypasses every cache and check.

### 4.2 Inspector

**Request scope.** New `src/inspector/requestScope.ts`: `createRequestScope()` returns
`{ get(key, fn) }`, a promise memo. Every promise — fulfilled or rejected — is kept for the
scope's life, so concurrent and later callers in one load share one request, and nobody in that
load retries a failure (a 429 included). The next load starts a new scope, which is what
"reload fetches again" means.

`loadAnnotation` creates one scope per load, next to `loadId`, and replaces it on the next
load. Every hooks, rules and labels list in the load path goes through it — the three loaders,
the panels' calls into them, and the attribution fallback (passed the scoped lister). Result:
each list once per annotation.

**429.** `safe()` stays a catch-all, but records a 429 on the current load
(`resolved.rateLimited = { retryAfter }`). A loader whose list was rate-limited does not set
`_hooksLoaded` / `_rulesLoaded` and does not write an empty `hooksById` / `rules`. The report
shows one notice, using `rateLimitMessage`: "Some data could not be loaded — Rossum is
rate-limiting requests…", in place of conclusions drawn from the missing lists. Reloading the
annotation fetches them again.

### 4.3 Galaxy

- `fetchOrgResources` owns an `AbortController`, combined with the caller's signal. The first
  failure of any list aborts the others; the abort errors of the siblings are not reported.
- A 429 shows `rateLimitMessage` with a **Retry** button that calls `loadGraph()`. No automatic
  retry. Other errors keep today's message.
- Not done: trimming the hooks list to the fields `graph.ts` reads. The API ignores `fields=` on
  lists (§2c.1).

### 4.4 Popup and side panel (`MdhProvenancePanel`)

The probe found no cheap way to see that a hook's settings changed (§2c.1), but cheap ways to
see that the queue's attached hooks changed (§2c.3) and that its schema changed (§2c.2). The
design uses each check only where it answers the question.

- **Hooks, non-empty entry:** unchanged — trusted for 5 minutes, then the full fetch. An SA who
  edits an MDH configuration still presses Refresh, as today.
- **Hooks, no MDH hook attached (`hadHooks: false`):** now cached, with `hookIds` — the ids of
  the queue's attached hooks as the full fetch saw them. Every open renders the cached message
  at once and, in the background, sends `GET /queues/X?fields=hooks`. Same set → keep.
  Different set → full fetch and re-render, through the existing `refreshNonce` path the
  annotation freshness check already uses. This is what keeps the first MDH hook an SA attaches
  visible on the next open. The entry also expires after 5 minutes as a backstop: within the
  window it is shown and the attachment check runs; after it, the full fetch runs. The
  attachment check cannot see an attached inactive MDH hook being activated, so without the
  backstop that change would stay hidden.
- **Hooks attached but no configuration applies (`hadHooks: true`, empty entries):** cached with
  the 5-minute window of a non-empty entry. What would change it is an edit to a configuration's
  `queue_ids`, which the attachment check cannot see.
- **Schema:** after its 5-minute window, the cached view renders at once and a background
  `GET /schemas?queue=X` compares `id` + `modified_at` with the entry's `sig`. Unchanged → the
  window restarts. Changed → full fetch and re-render. This replaces the blocking queue GET plus
  full schema GET.
- **Annotation entry:** written on the empty path too (`modifiedAt`, `queueId`). On the empty
  path the background annotation check asks `GET /annotations/X?fields=queue` and refreshes only
  when the queue changed, so an edit to the annotation no longer forces a full refetch. The
  loaded path keeps the `modified_at` check.
- New keys (`hadHooks`, `hookIds`, the schema's `sig`) are additive. An old entry without them
  behaves as today, so no prefix bump.
- Effect per open. Empty queue: the full hooks list (16,649 bytes for four hooks on the probe
  org) becomes a ~250-byte check, and both requests leave the critical path; the request count
  stays at two (the attachment check and the small annotation `?fields=queue` check). After the schema window: two requests (queue + full schema) become one
  372-byte request.

**429.** A foreground 429 shows `rateLimitMessage` instead of `Failed: HTTP 429`. The schema
load and the annotation-values load, which today swallow every error into empty data, let a 429
through, so it can neither become "No MDH matching on this queue" nor be cached as empty values. A 429 from a
background check keeps the cached view and changes nothing. The lock banner is unchanged: it
already returns `null` on any failure.

## 5. Ruled out by the probe

- **A per-hook `(id, modified_at)` signature** for the popup's hook cache — the list ignores
  `fields=`, so the "cheap" check would download every full hook object.
- **Trimming Galaxy's hooks list** — same reason.
- **Undocumented list filters** (for example a `modified_at` lower bound) were not tried: the
  design relies only on documented parameters.

## 6. Testing

Test-first; mutation-check every new guard (the repo rule).

- `rateLimit`: seconds parsed; absent, non-numeric and HTTP-date → `null`; both messages.
- `requestScope`: concurrent calls share one run; a success is reused; a failure is reused too
  (no second run); separate scopes do not share.
- Inspector: one annotation load with every panel mounted → `listHooks` once, `listRules` once,
  `listLabels` once; a 429 on hooks → the notice shows, `_hooksLoaded` is false, no "no hooks"
  conclusion; a new load uses a new scope.
- Galaxy: a 429 on one list aborts the others (no further page requests); the Retry button
  reloads; a 403 still degrades to `[]`.
- Popup: a queue with no MDH hook — the second open renders without waiting and sends only the
  annotation and attachment checks; an unchanged attachment set → no full fetch; a new hook
  URL → full fetch and re-render. `hadHooks: true` with nothing applying → the right message,
  no check inside the window. Non-empty hooks → today's behaviour. Schema: no request inside
  the window; after it, an unchanged `sig` → no full fetch, a changed one → full fetch and
  re-render. An old entry without the new keys behaves as today. Refresh bypasses all; a
  foreground 429 shows the message; a background 429 keeps the view.
- `npm run typecheck`, `npm test` (with `NODE_OPTIONS=--no-experimental-webstorage` on
  Node 26), `npm run format:check`, `npm run build`.

## 7. Delivery

One PR from `perf/api-call-reduction`, branched from `master` at `d8b6e01`. Open PRs #20 and
#21 (org name and cell) touch none of these source files; the only expected conflict is
`CLAUDE.md`, if this PR documents the 429 rules there.
