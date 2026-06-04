# Audit & Activity console — design

**Date:** 2026-06-04
**Status:** Approved (design); pending spec review → implementation plan

## Overview

Rebuild the console's **Audit** app (today a single-purpose `/audit_logs` viewer in
`src/audit/`) as a **unified Audit & Activity console** spanning the Rossum log /
activity surfaces that are actually accessible, with cached name-resolution and
deep-linking into the Rossum UI.

This is a from-scratch redesign of `src/audit/` internals. It builds on the
existing console app-switcher (left rail: **Data** ↔ **Audit**); the Audit app
gains a top tab bar over four sources. Dataset Management is untouched.

## Goals

1. One Audit app with a top tab bar over four sources: **Audit Logs**, **Hook
   Logs**, **Workflow Activity**, **Rules Execution**.
2. Each source uses the API correctly (right pagination, all useful server-side
   filters, totals) — fixing the current viewer's mis-pagination.
3. A right-side detail panel for rich payloads (esp. hook request/response/settings).
4. Resolve referenced IDs (hook/queue/user/rule) to names (cached) and deep-link
   annotation/queue/hook into the Rossum UI.
5. Per-source graceful states (unavailable / error / empty), so one forbidden
   source never breaks the others.

## Non-goals

- `config_history` (verified 403 even for organization_group_admin — see facts).
- Any write/mutating actions; exports.
- Changes to Dataset Management or the console shell/auth flow.

## Verified API facts (live probe, 2026-06-04)

Probed `https://api.elis.rossum.ai/v1` with the provided test token (role
`organization_group_admin`). The extension reaches the identical API at
`${uiOrigin}/api/v1/…` with the page's Bearer session token; only the host/scheme
differ between the probe and runtime.

| Source | Endpoint | Status | Pagination | Totals | Server search |
|---|---|---|---|---|---|
| Audit Logs | `/audit_logs` | 200 | **cursor** (`cursor`, `page_size`) | via `include_total=true` → `pagination.total` (238), `total_pages` | no |
| Hook Logs | `/hooks/logs` | 200 | **offset** (`page`, `page_size`) | `pagination.total` (43) by default | yes (`search`) |
| Workflow Activity | `/workflow_activities` | 200 | **cursor** (`cursor`, `page_size`) | via `include_total=true` → `total` (18) | no |
| Rules Execution | `/rules_execution_logs` | 200 | **offset** (`page_size`) | `pagination.total` (0 here) by default | yes (`search`) |
| Config History | `/config_history` | **403** | — | — | — |

`config_history` is **excluded** from the design: it returned `403 "You do not
have permission to perform this action"` even for an `organization_group_admin`
token, so it is effectively unavailable to normal users.

Cursor sources expose `pagination.next` containing a `cursor=…` query value and
need `include_total=true` to populate `total`. Offset sources return `total` /
`total_pages` / `next` (with `page=N`) by default.

**Current viewer is wrong on two counts** (motivating the rebuild): it sends
`page`/`page_size` to a **cursor** endpoint (so `page` is ignored), and never
sends `include_total`, so the count is unavailable. It also exposes only
`object_type` + `action`, ignoring `object_id`, `timestamp_before/after`,
`username`.

### Per-source verified parameters & shapes

- **`/audit_logs`** params: `page_size`, `cursor`, `include_total`, `object_type`
  (enum document/annotation/user — required), `action` (per-type), `object_id`,
  `timestamp_before`, `timestamp_after`, `username`. Row: `{organization_id,
  timestamp, username, object_id, object_type, action, content{path, method,
  request_id, status_code, details}}`. Per-type actions: document→`create`;
  annotation→`update-status`; user→`create/delete/purge/update/destroy/app_load/
  reset-password/change-password`.
- **`/hooks/logs`** params: `request_id`, `log_level`, `hook` (id, multi),
  `timestamp_before/after`, `start_before/after`, `status`
  (waiting/running/completed/cancelled/failed), `status_code`, `queue` (id),
  `annotation` (id), `email` (id), `search`, `page_size`. Row keys: `log_level,
  action, event, request_id, organization_id, hook_id, hook_type, queue_id,
  annotation_id, message, start, end, settings, status, status_code, timestamp,
  uuid, request, response`.
- **`/workflow_activities`** params: `page_size`, `cursor`, `include_total`, `id`,
  `annotation` (id), `workflow_run` (id), `created_at_before/after`, `assignees`
  (user id), `action` (step_started/step_completed/approved/rejected/
  workflow_started/workflow_completed/reassigned), `ordering` (id/-id). Row keys:
  `id, url, organization, annotation, created_by, created_at, workflow,
  workflow_run, workflow_step, action, note, assignees`.
- **`/rules_execution_logs`** params: `created_at_before/after`, `rule` (id),
  `annotation` (id), `queue` (id), `request_id`, `execution_result`
  (success/failure/partial_success), `trigger_event`, `search`, `page_size`. Row
  keys: `rule_id, rule_name, queue_id, annotation_id, request_id, created_at,
  trigger_event, trigger_condition, trigger_condition_results,
  trigger_condition_values, execution_result, execution_error, actions`.

## Architecture — a source-descriptor shell

The four sources differ in pagination, filters, columns, detail, and search.
Instead of four bespoke screens, a single generic shell is driven by a per-source
**descriptor**:

```js
// shape (not literal types — this is JS)
descriptor = {
  key: 'audit' | 'hooks' | 'workflow' | 'rules',
  label: 'Audit Logs',
  paginationMode: 'cursor' | 'offset',
  supportsServerSearch: boolean,
  // returns { rows, page: { total, totalPages, nextCursor|nextPage, prevCursor|prevPage } }
  fetch(params, { signal }),
  filters: [ { name, kind: 'select'|'text'|'number'|'daterange', label, options?, required? } ],
  columns: [ { key, label, render(row, ctx) } ],   // ctx exposes the resolver + deeplink
  detail(row) -> [ { title, render() } ],            // sections for the right panel
  refs(row) -> [ { type: 'hook'|'queue'|'user'|'rule'|'annotation', id } ],
}
```

The shell composes: **TabBar** (sources) → **FiltersBar** (from
`descriptor.filters`) → **ResultsTable** (`descriptor.columns`) → **DetailPanel**
(`descriptor.detail`) → **Pagination** (handles cursor + offset). Each source is an
isolated, independently testable module; a future 5th source is one new
descriptor. This replaces today's `Filters.jsx` / `ResultsTable.jsx` /
`Pagination.jsx` / `RecordDetail.jsx` / `query.js` while reusing `ConnectionBar`,
`ErrorBanner`, `JsonTree`, `UnavailablePanel`.

## The four source descriptors

- **Audit Logs** (cursor + `include_total`). Filters: object_type (select, required),
  action (select, options depend on object_type), object_id (number), timestamp
  range (daterange → `timestamp_after`/`timestamp_before`), username (text).
  Columns: time · username · object_type · action · status_code(`content`) ·
  object_id. Detail: method, path, status_code, request_id (copyable),
  `content.details` JSON tree. No server search → client quick-filter over the
  loaded page. Refs: `{type: object_type, id: object_id}` for deep-link
  (annotation/document/user); username is already a string.
- **Hook Logs** (offset; server `search`). Filters: hook (id), queue (id),
  annotation (id), status (select), status_code (number), log_level (select),
  timestamp range, request_id (text), search (text). Columns: time ·
  hook(resolved name) · event · status · status_code · queue(resolved) ·
  annotation(link) · duration(`end`−`start`). Detail: message; **request /
  response / settings** JSON trees; uuid; request_id. Refs: hook_id, queue_id,
  annotation_id.
- **Workflow Activity** (cursor + `include_total`). Filters: annotation (id),
  workflow_run (id), assignees (user id), action (select), created_at range,
  ordering (select id/-id). Columns: time · action · annotation(link) ·
  created_by · assignees(resolved) · note. Detail: links to
  workflow/run/step, full note. No server search → client quick-filter. Refs:
  annotation, workflow_run, assignees (users).
- **Rules Execution** (offset; server `search`). Filters: rule (id), annotation
  (id), queue (id), execution_result (select), trigger_event (text), request_id
  (text), created_at range, search (text). Columns: time · rule_name ·
  queue(resolved) · annotation(link) · trigger_event · execution_result ·
  execution_error. Detail: trigger_condition + `trigger_condition_results` /
  `trigger_condition_values`, `actions`, execution_error, request_id. Refs:
  queue_id, annotation_id (rule_name already present).

## Reference resolution & deep-linking

- **`resolve.js`** — a cached id→name resolver (reuse the MDH 60s-TTL LRU pattern)
  with `GET /hooks/{id}` (name), `/queues/{id}` (name), `/users/{id}`
  (username/name), `/rules/{id}` (name). Misses or failures fall back to the raw
  ID; resolution is lazy (per visible row) and deduped. Rules already carry
  `rule_name`, so the resolver is mainly for hook/queue/user.
- **`deeplink.js`** — builds Rossum UI URLs from the **UI origin** the console
  already holds (passed through the console auth flow). Annotation/queue/hook
  references render as links opening in a new tab. Cross-org entries (possible with
  group-admin tokens) whose `organization_id` doesn't match the current origin
  degrade to a non-link ID.
- **OPEN ITEM (verify at implementation, do not assume):** the exact UI route per
  resource type (annotation, queue, hook). To be confirmed against the running
  Rossum UI before wiring the link targets; until confirmed, links are built
  behind a single `deeplink.js` map so only that file changes.

## Module layout (replaces `src/audit/` internals)

```
src/audit/
  index.jsx            initAudit() — same contract with the console shell (boot, connected signal)
  store.js             activeSource + per-source { filters, rows, page, selectedRow, loading, error, availability }
  api.js               generic GET + 401/403 handling (kept); thin per-source list fns
  resolve.js           cached id->name resolver (hooks/queues/users/rules)
  deeplink.js          build Rossum UI URLs from the origin (route map; the OPEN ITEM lives here)
  sources/
    auditLogs.js       hookLogs.js   workflowActivities.js   rulesExecution.js   (descriptors)
  components/
    TabBar.jsx  FiltersBar.jsx  ResultsTable.jsx  DetailPanel.jsx  Pagination.jsx
    ConnectionBar.jsx  ErrorBanner.jsx  JsonTree.jsx  UnavailablePanel.jsx   (reused)
```

Removed: `Filters.jsx`, `ResultsTable.jsx` (replaced by generic), `Pagination.jsx`
(replaced), `RecordDetail.jsx` (→ `DetailPanel.jsx`), `query.js` (→ descriptors +
shell query effect). `quickSearch.js` is generalized into the shell's client-side
quick-filter (used for sources without server search).

## Boot / init within the console shell

`initAudit()` keeps its existing contract (the console shell awaits it for the
initial app and lazily on first activation; it sets the audit store's `connected`
signal). On init it restores persisted `activeSource` + per-source filters
(`chrome.storage.local`, e.g. `auditActiveSource`, `auditFilters_<source>`), runs
the connection probe, and registers the query effect (gated on `activeApp ===
'audit'`, per the existing flake-safe pattern). Switching tabs/filters/page issues
a fetch via the active descriptor with stale-result cancellation (queryId counter,
as today).

## Availability, errors, empty states (per source)

Availability is tracked **per active source**, not globally: a 403 → render
`UnavailablePanel` for that tab (role/plan gating, as config_history shows); other
errors → `ErrorBanner`; HTTP 200 with zero rows (e.g. Rules returned `total: 0`)
→ a friendly empty state. The tab bar always stays usable so the user can switch
to an accessible source.

## Pagination handling

`Pagination.jsx` renders from the normalized `page` object the descriptor returns.
For **offset** sources it shows page N / total_pages and prev/next via `page`. For
**cursor** sources it extracts the `cursor` value from `pagination.next` /
`previous` and shows prev/next (+ total/total_pages when `include_total` is
requested). The shell always requests `include_total=true` for cursor sources so a
count is shown.

## Testing

- Unit (pure logic): descriptor filter-state → query-param building per source;
  cursor extraction from `pagination.next`; offset page math; `resolve.js` cache
  hit/miss + fallback; `deeplink.js` URL builder; per-source response→row mapping.
- Component (jsdom, repo convention — `h(Component, null)` render, `vi.mock('../api.js')`,
  condition-based `waitFor`): TabBar switches source; FiltersBar emits filter
  changes; ResultsTable renders columns + row select → DetailPanel; per-source
  availability (403 → UnavailablePanel).
- `npm test` fully green before done. Update `CLAUDE.md`'s Audit section.

## Phasing & out of scope

The spec covers all four sources. Implementation may land **shell + Audit Logs
first** (proves the descriptor shell), then add Hook Logs, Rules Execution, and
Workflow Activity descriptors (each additive, one module + tests). Out of scope:
config_history, exports, write actions.

## Open items for the implementer / user

1. **Deep-link UI routes** (§ Reference resolution) — confirm the exact Rossum UI
   route for annotation/queue/hook before wiring `deeplink.js`.
2. Per-source columns/filters in § "The four source descriptors" are the proposed
   set; trivial to add/drop during implementation.
