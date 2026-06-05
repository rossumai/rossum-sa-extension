# MDH per-org scoping of Saved / Recent / last queries — design

**Date:** 2026-06-04
**Status:** Implemented. (Org-id source corrected to `/internal/token_info` on 2026-06-05 — system users' `/auth/user` org is always 1; see Verified facts.)

## Overview

In Dataset Management (MDH), the **Saved** queries, **Recent** query history, and the
reload-restore **last query** are stored under **global** `chrome.storage.local`
keys, so they are pooled across every Rossum project (organization) the user opens
MDH from. Entries reference collection names that may not exist in another org,
making the shared library confusing. Scope all three **per organization id** so each
project has its own library.

## Goals

1. Saved / Recent / last-query are isolated **per organization**, persisting
   long-term within an org and never bleeding across orgs.
2. Correct even on shared clusters (e.g. `elis.rossum.ai`) where many orgs share a
   single UI origin — so the key is the **org id**, not the domain.
3. Graceful: if the org id can't be resolved, degrade to per-domain scoping rather
   than breaking the feature.

## Non-goals

- **No migration / import** of the existing global data. Each org's library starts
  fresh; the old global keys are left in storage, untouched and unread.
- No change to MDH features beyond the storage key namespacing + the one org-id
  lookup.

## Verified facts (grounded)

- Current global keys (no namespacing): `savedQueries`, `queryHistory`
  (`src/mdh/components/QueryHistory.jsx`), and `mdhLastPipeline`
  (`src/mdh/lastPipeline.js`). Entries are `{ collection, pipeline, ts, variables?,
  name? }` — **no org/domain field**, so existing entries cannot be attributed to an
  org (hence no reliable migration).
- MDH holds `domain` (UI origin) + `token`; it currently calls only `healthz`. Org
  identity comes from **`GET {domain}/api/v1/internal/token_info` →
  `organization_uuid`** — the org the *token* belongs to (the customer/project org).
  `/auth/user.organization` was rejected: it returns the signed-in *user's* home org,
  which for a Rossum **system user** is always org 1 regardless of which project they
  work in (user-confirmed; the token itself belongs to the customer org).
- **Live-verified (2026-06-05):** for a system user, `GET /internal/token_info` → 200
  with `organization_uuid` = the **customer org** (org 214757 / uuid `85e6d56e…`),
  while `/auth/user` for the same user returns home org **1** — conclusive. token_info
  needs an authorized **session token** (the Bearer `secureToken` the extension uses;
  it accepts both schemes). A *different* long-lived API key earlier got 401 on
  token_info, so `getOrgId()` returns null on failure → domain fallback. Domain alone
  doesn't distinguish orgs on shared clusters; the org uuid does — hence the org uuid
  is the scope key.

## Decisions

| Decision | Choice |
|---|---|
| Scope key | Organization id (`org:<id>`); fallback `domain:<origin>` if org id unavailable |
| Keys scoped | `savedQueries`, `queryHistory`, **and** `mdhLastPipeline` |
| Migration | None — start fresh per org; old global keys left untouched/unread |
| Org-id source | `GET {domain}/api/v1/internal/token_info` → `organization_uuid` (the token's org) |

## Design

**Org-id resolution.** New `getOrgId()` in `src/mdh/api.js`: `GET
${baseDomain}/api/v1/internal/token_info`, return `organization_uuid` (a UUID string)
or `null` on any failure. token_info gives the *token's* org (the customer org), not
the user's home org, and needs the session Bearer token — which is exactly what MDH
uses at runtime. `orgId` therefore holds a UUID string; `scopeSuffix()` works
unchanged (`org:<uuid>`).

**Store.** New signal `orgId` in `src/mdh/store.js` (default `null`).

**Scope helper.** A single function (in `src/mdh/store.js`, alongside `orgId`):

```js
export function scopeSuffix() {
  return orgId.value != null ? `org:${orgId.value}` : `domain:${domain.value}`;
}
```

**Boot sequencing (`src/mdh/index.jsx` `initMdh`).** Resolve the org id **before**
any scoped read:
1. `store.orgId.value = await api.getOrgId();` (swallow errors → stays `null`).
2. Read the scoped last-pipeline key and restore from it (see below).
3. Existing `healthz` / persisted-state restore / effects unchanged (the `healthz`
   probe may run in parallel with the org-id call).

**Key namespacing.**
- `QueryHistory.jsx` — `readList`/`writeList` operate on `` `${baseKey}::${scopeSuffix()}` `` for `baseKey ∈ {savedQueries, queryHistory}`. All callers
  (`addToHistory`, `saveQuery`, `unsaveQuery`, `isSaved`, the `SavedList`/`HistoryList`
  panels) go through these, so no other change is needed. The legacy
  `chrome.storage.sync` merge in `readList` becomes a no-op for the new scoped keys
  (no old data under them) — consistent with "start fresh"; it is removed to avoid
  dead code.
- `lastPipeline.js` — replace the `LAST_PIPELINE_KEY` constant with a
  `lastPipelineKey()` returning `` `mdhLastPipeline::${scopeSuffix()}` ``;
  `saveLastPipeline` writes it, and `initMdh` reads `stored[lastPipelineKey()]` (after
  org-id is resolved). `bootPrefillFor` is unchanged (operates on the passed value).

**Timing.** Org id resolves during `initMdh` (connect). The Saved/Recent panel and
the editor (which writes last-pipeline) are only reachable by later user action, so
`orgId` is always set by read/write time. A failed lookup yields the domain-scoped
fallback (still per-project on `rossum.app`, still never global).

## Edge cases

- **Org-id lookup fails / offline:** `orgId` null → domain fallback. Library still
  works, scoped by origin.
- **System / group-admin users:** handled — `token_info.organization_uuid` is the
  org the *token* belongs to (the customer project), so it's correct even though such
  a user's `/auth/user.organization` (home org) is always org 1.
- **Old global data:** remains in `chrome.storage.local` under the unscoped keys,
  never read or deleted. (A future cleanup could remove it; out of scope here.)

## Testing

- `getOrgId`: returns `organization_uuid` from a mocked `/internal/token_info`
  response; returns `null` on HTTP error and when `organization_uuid` is missing.
- `scopeSuffix`: returns `org:<id>` when `orgId` set; `domain:<origin>` when null.
- `QueryHistory`: `saveQuery`/`addToHistory`/`isSaved`/`unsaveQuery` read & write the
  **org-scoped** keys (mock `chrome.storage.local`); verify two different `orgId`
  values keep separate lists and that a null `orgId` uses the domain key.
- `lastPipeline`: `saveLastPipeline` writes `mdhLastPipeline::org:<id>`; update
  `tests/mdh-last-pipeline.test.js` for the new key + scoping.
- Full `npm test` green; `npm run build` clean.

## Out of scope

Importing/migrating the old global library; deleting the old global keys; scoping
any other MDH state (view/collection/panel/widths persist fine globally and aren't
project-confusing).
