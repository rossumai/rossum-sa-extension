# Configuration changelog in context — design

**Date:** 2026-09-29
**Status:** built (staged). Simplified on 2026-09-29 to the open object only, and on
2026-09-30 to the DevTools panel only.
**Scope:** new `src/changelog/` (pure core), `src/devtools/` (a version rail and diff),
`src/usage/event.ts` + `PRIVACY.md` (one event), `package.json` (`@codemirror/merge`).

## 1. Why

Rossum records every create, update and delete of a configuration object in the
Configuration Changelog (`/settings/configuration-changelog`). The page is org-wide: to see
the history of the hook you are editing, you open Settings, filter by type and id, and lose
the page you were on. The filters live in localStorage, not the URL, so nothing can link to
a pre-filtered list.

This design shows the history of **the one object you have open**, and nothing else, in the
**DevTools "Rossum" panel**, which already shows the API resource behind the page (§5). It is
the only place the feature lives.

## 2. Verified facts this design rests on

Read-only probes on the internal elis org, 2026-09-29, plus the public OpenAPI spec
(`/api/docs/openapi/openapi-specs/openapi.json`) and the dashboard's public JS bundle.

**a. Endpoint.** `GET /api/v1/configuration_changelog`. Newest first by `version_id`.
`page` + `page_size` (max 100); `pagination.total` is returned. **Admin and organization
group admin only; everyone else gets 403.**

**b. Filters used here:** `object_type`, `object_id` (one value each), `version_id` (a list,
for snapshots), `version_id_range_max`, `include_snapshot`.

**c. Types and ids combine as two independent lists** (`object_type=hook,rule&object_id=1,2`
also matches hook 2). Irrelevant with one type and one id, which is all this design sends —
but it is why a multi-object view would need a (type, id) filter on every row.

**d. Tracked types:** `hook`, `schema`, `queue`, `rule`, `email_template`, `trigger`,
`workspace`. The dashboard has detail pages for queue, hook, schema and rule, so those are
the four an open page can show.

**e. Entry.** `{version_id, object_type, object_id, name, version_event, changed_fields,
version_created_at, modifier_id, description}`, plus `snapshot` on request.

**f. `changed_fields` names top-level keys only** (`config`, `settings`, `actions`,
`status`, `name`, `description`).

**g. Some keys are not tracked.** `changed_fields=queues` on hooks returned nothing.

**h. Delete rows carry no name and no modifier** — even when a user deleted the object.

**i. `status`-only updates dominate queue history** on the probed org.

**j. A snapshot is NOT the live object.** It uses raw ids (`organization_id`, `creator_id`,
`modifier_id`, `hook_template_id`) where the GET uses URLs, and lacks `queues`, `run_after`
and `token_owner`. Diffing a snapshot against the live object shows false changes.

**k. Redaction.** `secrets`, `client_ssl_key` and `config.secret` come back as
`**REDACTED**`; for private extensions `config.code`, `url` and `runtime` too.

**l. Two snapshots in one call:** `version_id=a,b&include_snapshot=true`.

**m. Rossum's own version page:** `/settings/configuration-changelog/{versionId}?objectType=
{type}&objectId={id}`. It already renders a folding diff.

**n. Modifier names.** `GET /users?id=a,b` resolves them, deleted users included. `/users`
lists only members of the current org, so a modifier from another org (an SA working through
membership) cannot be named. The native page shows "User ID: N" in the same case.

## 3. Non-goals

Each of these was designed, and rejected or removed by the owner on 2026-09-29/30:

- **No side panel History view.** It was built (a Lookups | History switch showing the open
  object's history) and removed on 2026-09-30: DevTools is the only home.
- **No "recently changed" markers on list pages** (badges, dots, "since your last visit").
- **No related objects.** A queue shows the queue's own history, not its schema, hooks,
  rules, email templates or triggers.
- **No document view** ("what changed since this document arrived") and **no org-wide feed**.
  A page that is not about one queue, hook, schema or rule shows no history.
- **No blame notes** on the DevTools editor's keys, and no per-key filter.
- **No filters.** A "Hide status-only" toggle (fact i) was built and removed on 2026-09-30;
  every version is listed.
- **No restore.** Nothing writes to the org. If it ever returns, it must drop every
  `**REDACTED**` value before the PATCH (fact k).
- **No polling** and no background fetching.

## 4. Pure core: `src/changelog/`

DOM-free and unit-tested. Callers inject the fetcher.

| Module | Job |
|---|---|
| `api.ts` | `listEntries(get, filters, page)`, `snapshotPair`, `previousVersion`, `resolveUsers`, `isForbidden`; the entry type (fact e). |
| `names.ts` | `modifierLabel` ("System" for `null`, `User <id>` when unresolved, fact n), `versionPageUrl` (fact m). |
| `feed.ts` | `relativeAgo`. |
| `snapshotText.ts` | Stable, sorted-key, pretty-printed JSON of a snapshot, so key order is never a change. |

## 5. DevTools panel: version rail and diff

History applies to **detail** tabs of type queue, hook, schema and rule. On 403, on an error,
or with no versions, nothing appears.

- The history store reads **one page** of the object's history: enough for the version count
  and the admin check. A load that is superseded (invalidate + reload) never writes.
- A thin toolbar under the tab bar (hidden for file previews and the empty page tab) holds
  **Soft-wrap** on the left (display only; Alt+Z, stored as `devtoolsLineWrap`) and, on the right, a
  `N versions` button that toggles a rail: a Live row, 20
  versions then Load more (it opens on the history store's page 1 without fetching it again;
  a page is 100, so Load more reveals buffered rows before it
  fetches the next page). The rail resolves modifier names the store
  did not.
- Selecting a version replaces the editor with a **read-only unified diff against the version
  before it** — never against the live object (fact j). The previous version comes from the
  store's page when it is there, else one query with `version_id_range_max = selected − 1`
  and `page_size=1`. Both snapshots come from one call (fact l), serialised by
  `snapshotText.ts`, rendered by `@codemirror/merge` with unchanged lines collapsed. A
  `create` shows its snapshot alone.
- A banner says both versions the way the rail rows do, by when and by whom — "Changes
  from 9 d ago by Jane Doe, against the version from 21 d ago by John Roe" ("Created … by …"
  for a create), exact time on hover — and never by version id, which appears nowhere else
  in the panel. The selected row in the rail carries **Diff ↗**, which opens Rossum's own
  page for that version. The rail labels the
  version being compared against (**compared**) when it is loaded, so both ends of the diff
  are visible. There is no Back to live button: the rail's **Live** row, or closing the
  rail, returns to the editor. It adds "secrets changed, values hidden" when `changed_fields` lists `secrets`, and
  "No visible difference — the changed values are redacted by the API." when the two
  snapshots serialise identically (fact k).
- Changed text is tinted on both sides: the old side in the merge view's own red
  (`rgba(255, 0, 0, 0.2)`), the new side in its green at the same strength
  (`rgba(34, 187, 34, 0.2)`) instead of the view's default 2px underline.
- **Unsaved edits survive:** the buffer lives in the store, and Save is hidden while a
  version is shown. A successful Save invalidates the history, which reloads.
- Snapshots are immutable and stay cached by `version_id` for the panel session. That cache
  and the history store are keyed by ids unique only within one org, so both are dropped
  when the inspected page moves to another org.

`@codemirror/merge` uses a caret, like the rest of the CodeMirror family (exact pins install
a second `@codemirror/state`). It is checked in the BUILT bundle for `eval` / `new Function`.

## 6. Usage data

One parameterless event, in `EVENT_NAMES` and in `PRIVACY.md`:
`sa_devtools_history_open` — the version rail was opened.

## 7. Testing

- Unit tests for every core module, on fixtures with the real field layout and placeholder
  names and ids only.
- Component tests: the rail's button, 20-row buffer, stale and double-click Load more and
  name resolution; the store's one-page load and its invalidate race; the diff's
  previous-version lookup, create, secrets, redacted-identical and missing-snapshot cases;
  unsaved edits across the diff view.
- Browser dogfood on an internal org is owed (jsdom has no layout).

## 8. Open items

- The rail and diff in dark mode are unverified in a real browser.
- Whether the changelog lists a just-saved PATCH immediately is unverified.
