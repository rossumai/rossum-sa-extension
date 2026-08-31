# MDH search indexes on API V2 — design

**Date:** 2026-08-28
**Supersedes:** `2026-06-10-mdh-search-index-copy-paste-design.md`, removed with this change. It
specified `toCreateSearchIndexDefinition` and the `latest_definition` → flat-camelCase transform,
both of which are deleted: V2 returns a definition that is already valid input to a `PUT`, so the
Copy → Create round trip it existed to fix no longer needs a transform at all.
**Status:** implemented 2026-08-31; verified in the browser by the owner.
**Owner decisions, verbatim where they settle something:**
- Progress after a write: **"Badges only, live-polled"** — the row appears immediately with a
  `pending create` badge and updates itself; no notice stripe.
- Create modal: **"Separate name field + definition editor"** — a text input for the name beside a
  JSON editor holding only the definition.
- Standing: "Always consider backward compatibility"; "Never leak customer names or customer data";
  "All decisions must be verified first and grounded in facts."

## 1. What changes, in one paragraph

The Dataset Management app stops talking to Data Storage about Atlas Search indexes. The three
endpoints it uses — `POST /svc/data-storage/api/v1/search_indexes/{list,create,drop}` — were
re-hosted onto Master Data Hub some time before 2026-08-18 and now carry a `Sunset` header for
2027-12-31. The panel moves to the MDH V2 subresource
`/svc/master-data-hub/api/v2/datasets/{name}/search_indexes`, which is a declarative registry
rather than a command API: you `PUT` a desired declaration, a reconcile job applies it to the
engine, and the resource reports its own progress. That removes the operation-id round trip
entirely — and with it a bug that is live in the shipped extension today.

## 2. Verified facts this design rests on

Probed live on 2026-08-26 and 2026-08-28 against `elis.rossum.ai`, organization 1, with an
org-admin token, on throwaway collections created and dropped inside each run. The organization
was left with the 21 collections it started with, each time. Nothing below is inferred unless it
says so.

**The endpoints already moved.** A malformed body sent to
`POST /svc/data-storage/api/v1/search_indexes/list` returns a 422 whose traceback names
`/app/svc/master-data-hub/svc/master_data_hub/web_api/routers/v2/search_indexes_compat.py`.
`indexes/*` and `data/*` still name `/app/svc/data-storage/…`, so this is scoped to search
indexes; Data Storage as a whole is not retiring.

**The clock.** `Deprecation: @1787011200` (2026-08-18 00:00 UTC) and
`Sunset: Fri, 31 Dec 2027 00:00:00 GMT` appear on every successful search-index response — on the
Data Storage path *and* on `/api/v2/compat/data_storage/search_indexes/*`. No other Data Storage
endpoint carries them. The compat shim is therefore not a migration target: its request and
response schemas are byte-identical to the Data Storage ones (diffed from both OpenAPI documents)
and it expires on the same day.

**The live bug.** Create and Drop now return
`content-location: …/svc/master-data-hub/api/v2/compat/data_storage/operation_status/<uuid>`, and
that id 404s on `/svc/data-storage/api/v1/operation_status/<uuid>`. `api.ts` builds the poll URL
from `serviceBase` (`{domain}/svc/data-storage`), so `waitForOperation` takes five 404s at 600 ms,
throws `pollUnavailable`, and `useOperationStatus` shows "still running — use Refresh to confirm"
about three seconds after the click. `onFinished` never fires, so the panel never re-lists. The
index itself builds correctly. Verified for both create and drop. `collections/drop` still returns
a Data Storage operation URL, so the two operation stores are genuinely separate.

**The V2 lifecycle.** A valid `PUT` returns 202 with
`{"message": "Search index 'x' on dataset 'y' has been declared.", "type": "info"}` — **no
operation id and no `content-location`**. The resource then reports its own progress:
`PENDING_CREATE` at 0.7 s, `PENDING` at 32.7 s, `READY` at 55.1 s. A `DELETE` returns 202 the same
way and the row disappeared after about 8 s.

**There is no operations feed to reuse.** `GET /api/v2/operation/?dataset_name=<probe>` was empty
at five checkpoints across the reconcile, so search-index work is not recorded there. Completion
tracking has to be polling of the search-index list itself.

**Failure surfaces as a status, with no message.** A definition that Pydantic accepts but the
engine rejects (`analyzer: "lucene.definitely_not_an_analyzer"`) lands at `status: FAILED`,
`queryable: false`, and the single-index `GET` carries no error field. The deprecated path's
operation record does report `error_message`, but its text is
`"SearchIndexError: Search index build failed for ['x'] on 'y'"` — the index and dataset names,
not the engine's reason. Nothing diagnostically useful is lost.

**Statuses observed live:** `PENDING_CREATE`, `PENDING_UPDATE`, `PENDING`, `BUILDING`, `READY`,
`FAILED`, `PENDING_DELETE`, and `DELETING` from the compat list. `STALE` is in the OpenAPI enum but
was never produced. `DELETING` is *not* in the enum — the compat list emitted it anyway.

**`PUT` is a genuine upsert, and a failed edit is non-destructive.** A healthy index left to reach
`READY` was then re-declared with a definition the engine rejects: `PENDING_UPDATE` at 0 s,
`BUILDING` at 24 s, `FAILED` at 44 s, version 0 → 1 — and **`queryable` stayed `true` the whole
time**, so the previous build kept serving. `FAILED` with `queryable: true` is therefore a real
combination the UI must tolerate: the red card must not imply the index is down, and the
`not queryable` badge correctly does not appear. `aiContext.summarizeSearchIndexes` already
excludes any non-`READY` index, which stays the right behaviour — the current definition is the
failed one, not the one actually serving, so describing its fields to the agent would be wrong.

**Shapes, compared on the same real indexes.** The native list item is
`{name, definition, queryable, status, latest_definition_version?}`. Its `definition` is
consistently snake_case — including nested `token_filters` and `char_filters` — and omits null
optionals. The compat list item is
`{name, type:"search", status, queryable, latest_definition:{…}, latest_definition_version}`, whose
top level is snake_case but whose nested analyzers are camelCase (`tokenFilters`, `charFilters`),
and which emits explicit nulls. `latest_definition_version.created_at` is a plain ISO string on
native and `{"$date": …}` on compat.

**Two definition casings can both come back.** An index with a current registry declaration
returns snake_case; one that exists only on the engine returns the engine's normalized camelCase
verbatim, as the OpenAPI docstring says. Both were seen on one collection: after a bulk `PUT []`
removed the declarations, the surviving engine copies rendered camelCase. *Unverified:* whether a
real customer organization still has engine-only indexes from before the re-host — the probe
organization had none, and creates now write the registry, so one cannot be manufactured.

**Input is generous.** `searchAnalyzer` and `search_analyzer` both validate (`populate_by_name`,
which the OpenAPI cannot show). `type` values are snake-cased before validation: `embeddedDocuments`
is accepted and stored as `embedded_documents`, and the 422 for a body saying `objectId` echoes
`'input': 'object_id'`. Explicit `null` optionals are accepted. A body carrying `indexName` is a
422 `extra_forbidden` — the name lives in the URL.

**No capability is lost.** Eight mapping types are supported: `string`, `number`, `date`,
`boolean`, `token`, `autocomplete`, `document`, `embedded_documents`. `objectId`, `geo` and `uuid`
are rejected with an eight-error union message — **and the deprecated compat create rejects them
identically**, because it is the same router. So the extension cannot create those today either.
Neither API can create a vector index: the create body requires `mappings` and has no `fields`.

**Error paths are clean.** `PUT` to a missing dataset → 404; `DELETE` or `GET` of an unknown index
→ 404; all with `{"message", "type"}`, which `api.ts`'s `data?.message` already reads. A rejected
definition returns a *string* — `MessageResponse` has no structured `detail` — holding a Python
repr of every Pydantic error. One unsupported mapping type produces **eight** of them, because the
type is reported against each of the seven union branches plus the top level.

**`latest_definition_version` arrives late, and its timestamp has no timezone.** The field is
absent between a `PUT` and the changelog write — a card can be `PENDING_CREATE` with no version —
and appeared about 6 s after the `PUT` in the probe. `created_at` comes back as
`"2026-08-28T11:16:21.756000"`: **UTC, with no offset marker**. Verified by comparing against the
wall clock at the moment of the `PUT` — it matched UTC to within the reconcile latency and was two
hours from local on a UTC+2 machine. The deprecated list returned the same instant as
`{"$date": "2026-08-28T11:16:21.756Z"}`, so the missing marker is new with V2. `Date.parse` reads
an offset-less date-time as *local* time, which would make the card read "just now" for two hours
and then under-report the age for ever after. Any parse of this field has to append `Z` first.

**`storedSource` and `numPartitions` are native-only, and the deprecated path drops them
silently.** They are fields of `SearchIndexDefinition` but not of `CreateSearchIndexRequest`, which
sets no `additionalProperties: false` — so the compat create accepts them with a 202 and discards
them. Verified by declaring the same definition both ways: the native index came back carrying
`stored_source: {include: [...]}` and `num_partitions: 1`, the compat one came back with both
`null`. (`multi` survives both, because it lives inside the untyped `mappings`.) Today's
`toCreateSearchIndexDefinition` also drops both, since it emits only six keys — so a listed index
can display them and still not be reproducible. The migration fixes this for free: Copy and Create
become pass-throughs over the whole definition.

**Deployment is uniform.** All seven reachable cluster hostnames — `elis.rossum.ai`,
`eu1/eu2/us/jp/shared-eu2.rossum.app`, `us.app.rossum.ai` — report
`code_version_hash 8867fdca009934238057320a6fe53e8f7d707218` and serve a byte-identical
`openapi-internal.json` (`sha256 262949f7…`). No per-cluster capability gate is needed.

**The codebase already depends on MDH V2.** `api.ts listOperations` calls
`${baseDomain}/svc/master-data-hub/api/v2/operation/` unconditionally, from a poll loop in
`src/mdh/index.tsx` and from `UploadsPanel`. Adding search-index calls introduces no new
assumption about MDH being reachable.

**A slash in a collection name breaks the V2 path.** `GET …/datasets/a%2Fb/search_indexes` returns
404 while the collection exists and the compat list finds it. Spaces, dots and `+` are fine. Data
Storage passed the name in the body, so it had no such limit.

## 3. The transport

`api.ts` gains one private helper beside `post` and `get`:

```
mdhRequest(method, path, body?, { signal }?) -> parsed JSON
```

It targets `${baseDomain}/svc/master-data-hub`, reuses `combinedSignal` for the 30 s timeout and
caller aborts, reuses the existing 401 message, and throws `apiError(data?.message || …, status)`.
It does **not** attach `operationId` — V2 writes have none, and inventing one would be a lie.

Three exported functions replace the three Data Storage ones:

```
listSearchIndexes(collection, { signal }?)          -> SearchIndexWithStatus[]   // bare array
putSearchIndex(collection, indexName, definition)   -> { message, type }         // 202
deleteSearchIndex(collection, indexName)            -> { message, type }         // 202
```

The collection name is `encodeURIComponent`-ed into the path.

Three decisions here, each with its reason:

- **The old functions are deleted, not kept as a fallback.** V2 is on every cluster with an
  identical build, the codebase already requires MDH V2 for the operations poll, and
  `tests/dead-code.test.ts` fails on an export nothing imports. Backward compatibility in this
  repo means *older shipped builds keep working*, and they do — the deprecated endpoints answer
  until 2027-12-31.
- **`listSearchIndexes` returns the bare array, not `{result}`.** V2 returns a JSON array at the
  top level. Wrapping it to preserve the old call sites would hide a real shape change behind a
  familiar-looking one; all three call sites are updated instead.
- **`operationIdFromResponse` and `checkOperationStatus` are left alone.** After this change
  nothing in the app receives an MDH operation URL, so hardening every async flow to follow
  `content-location` would be speculative work across `collections/drop`, `indexes/create` and
  `indexes/drop`. The bug in §2 is fixed by the migration itself. Residual risk, stated rather
  than mitigated: if another Data Storage endpoint is re-hosted the same way, the same bug returns
  for that endpoint.

## 4. Completion tracking — `hooks/useIndexReconcile.ts`

`useOperationStatus` takes an operation id and polls `operation_status`; V2 offers neither. A new
hook, used only by the Search Indexes panel, polls the list instead. `useOperationStatus` stays
exactly as it is for `IndexPanel`, which still has real operation ids.

```
const { watch, stop } = useIndexReconcile(onRows)
watch(collection)   // begin (or restart) polling that collection
stop()              // abort; called on unmount and on collection/panel switch
```

Behaviour:

- On `watch`, fetch the list at once so a newly declared row appears immediately, then re-fetch
  every **2 s** while any row is transitional, up to **180 s** (the observed create took 55 s;
  the cap is a backstop, not an expectation). Each result is handed to `onRows` and written to
  `cache.set(collection, 'searchIndexes', rows)` so the panel and the cache never disagree.
- **The panel also resumes the poll on load.** Writes are not the only way to arrive at a
  transitional index — opening the panel onto a build someone else started, or that was already
  running before the panel mounted, is just as common. So after a successful list the panel calls
  `watch` when any row is transitional. Without it a `PENDING_CREATE` badge sits there until
  someone presses Refresh, which is the exact complaint that prompted this hook.
- `onRows` is held in a ref rather than captured by `watch`'s closure: the panel re-renders on
  every poll, so a captured callback would go stale after the first tick.
- **Transitional:** `PENDING_CREATE`, `PENDING_UPDATE`, `PENDING_DELETE`, `PENDING`, `BUILDING`,
  `DELETING`. **Terminal:** everything else, *including a status this build does not recognise*.
  A future status can therefore only stop polling early — never spin forever. `DELETING` is
  included even though it is absent from the OpenAPI enum, because the compat list emitted it.
- A failed poll is swallowed and retried; three consecutive failures stop the loop, leaving
  whatever the panel last rendered. No banner — the badges are already honest, and the panel has
  a Refresh button.
- An `AbortController` per `watch`; a new `watch` aborts the previous one, so a late response from
  a previous collection cannot repaint the current one.

The global `opNotice` stripe is not used. The row's own badge says `pending create` and then
`ready`, which is what the stripe would have said.

## 5. `searchIndexDef.ts`

The Create modal now has a separate name field, so Copy no longer needs to embed a name. The
module keeps two functions, both pure and both tested:

```
toSearchIndexDefinition(idx)   -> idx.definition ?? {}     // what Copy copies and the card renders
splitPastedDefinition(parsed)  -> { name, definition }     // tolerates a legacy snippet
```

`toSearchIndexDefinition` is deliberately a pass-through with a guard: a native `definition`
round-trips into a `PUT` unchanged (verified), and an engine-only camelCase definition is
*also* valid input (verified), so there is nothing left to transform. The old function renamed and
emptied out is the honest outcome of the API having been fixed.

`splitPastedDefinition` exists for one reason: a body containing `indexName` is a 422, and users
have snippets copied from the current build. If the pasted object carries `indexName` or `name`,
that value is lifted out to pre-fill the name field and the key is removed from the definition.
Otherwise the object is the definition unchanged. This is additive tolerance — it cannot reject
anything the strict form would accept.

## 6. `SearchIndexPanel.tsx`

**Loading** — `api.listSearchIndexes(collection)` returns the array directly; the `res.result || []`
unwrap goes. Cache key and TTL are unchanged.

**Create modal** — a `class="input"` name field (matching `PromptBody` in `src/ui/Modal.tsx`) above
the existing `JsonEditor`, which now holds only the definition and defaults to
`{ "mappings": { "dynamic": true } }`. On submit: trim the name and require it; require the parsed
definition to be an object with `mappings`; then `putSearchIndex`. If the pasted JSON carries
`indexName`, `splitPastedDefinition` pre-fills the empty name field from it.

A 422 renders in the existing `.input-hint` div, but **only its first line**. The server returns
one error per union branch, so an unsupported mapping type fills the hint with eight near-identical
Python reprs; the first is representative and the count is already in the leading
`"N validation errors:"`. `firstValidationLine(message)` is a pure function in `searchIndexDef.ts`
— it takes everything up to the second `\n  {`, falling back to the whole string when the message
does not have that shape, so an unrecognised error is never swallowed.

**Card** — `definition={idx.definition}`, so `IndexCard` renders the definition and Copy copies it.
`IndexCard` itself does not change.

**Badges** — the `type` badge is removed; V2 has no `type` field, and no vector index can exist
through either API. Status renders as the API value lowercased with underscores as spaces —
`ready`, `building`, `pending create`, `pending update`, `pending delete`, `failed` — with
`index-badge-ready` for `READY`, `index-badge-pending` for the transitional set, and
`index-badge-failed` for `FAILED` and `STALE`. The `not queryable` badge is unchanged.

Each transitional badge carries a `title` explaining the state, because the API's vocabulary is
faithful but not self-explanatory: `PENDING_CREATE` → "Declared — the engine has not started
building it yet", `PENDING_UPDATE` → "A new definition is declared — the engine is still serving
the previous one", `PENDING_DELETE` / `DELETING` → "Removed from the declaration — the engine is
still dropping it", `BUILDING` → "The engine is building this index", `STALE` → "The engine's index
no longer matches the declaration". Keeping the API's own word on screen means a badge and a
support answer use the same term; the tooltip carries the meaning.

**Card meta** — `v{n} · declared {relative time}` from `latest_definition_version`, e.g.
`v2 · declared 3d ago`. `version` alone says an index was re-declared; `created_at` says when,
which is the half that answers whether someone changed it recently. Both fields are already in the
list response, so this costs no request. The meta is omitted entirely when
`latest_definition_version` is absent, which happens between a `PUT` and the changelog write.

`src/mdh/components/QueryHistory.tsx` and `UploadsPanel.tsx` each hold a private relative-time
formatter already, so a third would put the same grammar in three places. `QueryHistory`'s
`formatTime` ("just now" / "5m ago" / "3h ago" / a locale date beyond a day) is the right one here
and moves verbatim to **`src/mdh/relativeTime.ts`**, imported by `QueryHistory` and the panel. Its
behaviour does not change, so `QueryHistory`'s tests are unaffected. `UploadsPanel`'s stays where
it is — it formats operation durations at a finer resolution ("1h 20m ago") and is a different
grammar, not a duplicate of this one.

The same module gains `parseUtcTimestamp(value)`, which appends `Z` when the string carries no
offset before calling `Date.parse`, and returns `null` for anything unparseable. This is not
defensive padding: §2 records that V2's `created_at` really is offset-less UTC, and parsing it
without the `Z` is silently two hours wrong on a UTC+2 machine.

**A failed index that is still serving says so.** Verified: after a failed re-declaration the
status is `FAILED` while `queryable` stays `true` and the previous build keeps answering. The card
would otherwise be red with a `failed` badge and nothing else, reading as an outage. `IndexCard`
gains an optional `notice` prop — a node rendered between the header and the body, visible whether
or not the card is expanded, on `.record-card-body`'s surface. Only `SearchIndexPanel` passes it,
so the Indexes panel and the Stages view are untouched. The panel passes it when
`status === 'FAILED' && queryable`: "The engine rejected v{n}. The previous version is still
serving." When `queryable` is false the existing `not queryable` badge already tells the true story
and no notice is added.

**Drop** — `deleteSearchIndex`, then `watch()` the reconcile. The confirm copy in `IndexCard` is
unchanged.

**Slash-named collections** — if the selected collection name contains `/`, the panel renders a
single line explaining that search indexes cannot be managed for a collection whose name contains
a slash, and makes no request. Four lines, and it replaces a "Dataset 'a/b' not found" message that
would be a lie.

## 6a. Approved UI improvements

Three proposals were reviewed as browser specimens and approved on 2026-08-28. They are additive
to §6 and independent of each other. None of them revisits the 2026-08-13 redesign that was built
and reverted — that attempt replaced the JSON dump with a per-path table, surfaced analyzer
pipelines, synonym sets, `multi` and `storedSource` as UI, added a mapped-path coverage check with
typo suggestions, added a read-only `$search` bench, and tried four arrangements of Fabry
explanations. None of that reappears. The recorded lesson from that revert — that approving
mockups did not predict how the result felt with real data — is why each of these is small enough
to reverse on its own.

### 6a.1 Cards start collapsed, with a coverage summary in the header

`IndexCard` gains `defaultExpanded?: boolean`, defaulting to `true`; only `SearchIndexPanel`
passes `false`, so the Indexes panel and the Stages view are untouched. The header's existing
`.record-summary` slot carries a derived one-liner after the name, from a pure function in
`searchIndexDef.ts`:

```
summarizeDefinition(definition) -> string
  mappings.dynamic === true, no explicit fields  ->  "dynamic — all fields"
  mappings.dynamic === true, k explicit fields   ->  "dynamic + k fields"
  k explicit fields, dynamic false/absent        ->  "k fields: a, b, c…"  (first 3 named)
  exactly one field                              ->  "1 field: a"
  no mappings, or neither dynamic nor fields     ->  ""  (nothing rendered)
```

The string is built in a `.ts` module, not in JSX, so the em dash is an ordinary escape rather
than one of the JSX raw-text traps. Expanding a card still shows the identical definition in the
identical read-only editor — the JSON stays the single source of truth and only the header
changes.

### 6a.2 A collection-level sync line in the toolbar

The toolbar's title becomes a two-line stack: the existing title, and beneath it a muted line
derived from the same rows the reconcile poll already fetches. No extra request.

```
syncSummary(rows, lastCheckedAt) -> { text, working }
  0 rows                     ->  "no indexes"
  none transitional          ->  "3 indexes · in sync · checked just now"
  k transitional             ->  "3 indexes · 2 in progress · checked just now"
```

`in progress` covers creating, updating, deleting and building alike, because the indicator beside
it already carries the urgency and inventing four different words for one idea would not. Singular
is `1 index`.

**The indicator animates while work is in flight.** A static badge reading `pending create` looks
like a stuck one, so the sync line swaps its dot for a spinning ring, and every transitional badge
grows one through `.index-badge-pending::before`. That class is emitted only by `statusBadge`, so
the spinner cannot leak onto any other badge in the app. Both are pure CSS and both stop under
`prefers-reduced-motion: reduce`. The timestamp comes from `relativeTime.ts` and is the *poll's* own last-look time,
never a claim about the engine — so when polling has stopped, either because everything is
terminal or because the 180 s cap was reached, the line ages honestly instead of implying
freshness.

Data Storage reported one status per index and nothing about whether the engine had caught up.
This line exists because V2 is the first version to separate "the registry is ahead"
(`PENDING_*`) from "the engine is working" (`BUILDING`), so a collection-level answer had no
source before.

### 6a.3 Edit, because `PUT` is an upsert

`search_indexes/create` was create-only; changing an index meant Drop then Create, with the index
absent in between. V2's `PUT` is an upsert — verified: a changed definition on an existing name
returned 202, moved to `PENDING_UPDATE`, bumped the version 0 → 1, and the index never left the
list. A failed re-declaration is non-destructive: `queryable` stayed `true` and the previous build
kept serving.

`IndexCard` gains `onEdit?: () => void`, rendering an `Edit` button before `Copy` when supplied.
The Create modal becomes one function in two modes:

```
openIndexModal({ mode: 'create' | 'edit', name?, definition? })
  create — empty name input, focused; definition defaults to { "mappings": { "dynamic": true } }
  edit   — name input readOnly + .input-locked; definition prefilled from the card
  title  — 'Create Search Index' | 'Edit Search Index'
  submit — 'Create Search Index' | 'Save & rebuild'
```

Both modes call `putSearchIndex`. The name is read-only in edit mode because it is the resource
identity: a `PUT` under a different name creates a second index rather than renaming the first.
Editing is confined to the definition — no inline field editing and no form over the mapping; the
JSON editor stays the way a definition is changed.

The still-serving notice from §6 gains the same action, so a `FAILED` card is a loop rather than a
dead end: "The engine rejected v{n}. The previous version is still serving." followed by an
`Edit definition` button. The notice is therefore a node, not a string.

### 6a.4 Stylesheet

A small block joins `src/console/console.css` beside the existing `.toolbar` and `.record-actions`
rules: `.toolbar-stack`, `.toolbar-sync` with its `.dot` / `.dot-work` children,
`.record-actions .action-edit`, `.record-card-notice` with its `.record-card-notice-text` child,
and `.input-locked`. They belong in the monolith rather than in a new CSS Module: every class this
panel already uses is global and lives there, `.toolbar-group` is the existing precedent for a
`.toolbar` child, and a module holding rules that must cascade inside a global `.toolbar` would
fight the sheet it sits in. Every class name is long enough that
`tests/css-class-collision-boundary.test.ts` is unaffected.

## 7. Other call sites

- `prefetch.ts` — `cache.set(collection, 'searchIndexes', await api.listSearchIndexes(...))`; the
  `res.result || []` unwrap goes.
- `agent/aiContext.ts` — `summarizeSearchIndexes` reads `i.definition` instead of
  `i.latest_definition`. Its filter (`queryable !== false` and status absent or `READY`) is still
  correct against the V2 statuses.
- `cache.ts` — unchanged; only the key name `searchIndexes` is involved.
- `components/IndexCard.tsx` — three optional props: `notice` (a node between header and body,
  visible whether or not the card is expanded), `defaultExpanded` (default `true`) and `onEdit`
  (renders an `Edit` button before `Copy`). The Indexes panel and the Stages view pass none of
  them and behave exactly as now.
- `src/console/console.css` — the four rules listed in §6a.4.
- `components/QueryHistory.tsx` — its private `formatTime` moves verbatim to
  `src/mdh/relativeTime.ts` and is imported back. Behaviour identical.
- No usage event touches search indexes (`sa_mdh_index_create` is emitted only by `IndexPanel`), so
  `EVENT_NAMES` and `PRIVACY.md` are out of scope.

## 8. Tests

Fixtures are rebuilt from the real responses recorded during the probes, with every name replaced
by the placeholders CLAUDE.md requires (`acme`, `example`, `x`, `y`, `org`).

- `tests/mdh-api.test.ts` — the three entries in the endpoint table become the V2 paths; add
  assertions that `putSearchIndex` uses `PUT` with the name in the URL and the definition as the
  whole body, that `deleteSearchIndex` uses `DELETE`, that the collection name is percent-encoded,
  and that the base is `/svc/master-data-hub/api/v2/datasets/`.
- `tests/mdh-search-index-def.test.ts` — rewritten for the three functions, including the legacy
  `indexName` snippet, a camelCase engine-only definition passing through untouched, and
  `firstValidationLine` on a real eight-error 422 message plus a message that does not match the
  expected shape (must return it whole rather than swallow it).
- `tests/mdh-search-index-panel.test.tsx` — fixtures become native list items. Copy asserts the
  bare definition; the create flow asserts name-and-definition are sent separately and that an
  empty name is refused; badges assert the new status mapping, their `title` text, and the absence
  of a `type` badge; the meta asserts `v2 · declared …`, and its absence when
  `latest_definition_version` is missing; and a `FAILED` + `queryable: true` fixture must render
  the still-serving notice while a `FAILED` + `queryable: false` one must not.
- `tests/mdh-prefetch.test.ts`, `tests/mdh-agent-context.test.ts` — array return and `definition`.
- New `tests/mdh-index-reconcile.test.ts` — polls while transitional, stops on terminal, stops on
  an unrecognised status, aborts on `stop()`, and does not repaint after a collection switch.
- New `tests/mdh-relative-time.test.ts` — the four branches of the extracted formatter.
- `tests/mdh-search-index-def.test.ts` also covers `summarizeDefinition` (dynamic, dynamic with
  fields, one field, three-plus fields with the overflow ellipsis, and an empty result for a
  definition with neither) and `syncSummary` (no indexes, all settled, some in progress, singular).
- `tests/mdh-search-index-panel.test.tsx` also covers: cards render collapsed and expand on click;
  the header shows the coverage summary; the toolbar shows the sync line; `Edit` opens the modal
  with the name locked and the definition prefilled and submits a `PUT` under the same name; and
  the `FAILED` + `queryable` notice offers `Edit definition`.
- `tests/mdh-hooks.test.tsx` and the Indexes-panel tests must still pass untouched — that is the
  check that `IndexCard`'s three new props defaulted correctly.

## 9. Backward compatibility

- **Older shipped builds** keep working unchanged until 2027-12-31.
- **Existing customer indexes** are readable through V2 (verified) and droppable through it
  (verified for a registry-declared index, including the `default` one that `collections/create`
  makes automatically). *Unverified:* dropping an index that exists only on the engine, because
  such an index can no longer be created to test against.
- **Both definition casings** are rendered and both are valid input, so an index from before the
  re-host copies and re-creates correctly.
- **A saved Copy snippet** from the current build still works, via `splitPastedDefinition`.
- **No mapping type stops working.** The eight supported types are the same eight the deprecated
  endpoint accepts today.
- **Two definition keys start working.** `storedSource` and `numPartitions` are accepted and
  persisted by the native `PUT`, while the deprecated create takes them with a 202 and throws them
  away, and today's Copy transform drops them from a listed index. After the migration both
  round-trip, so an index using them can finally be copied and re-created faithfully.
- **Known regression:** a collection whose name contains `/` can no longer have its search indexes
  listed or managed. It is reported, not hidden.

## 10. Out of scope

Nothing else moves off Data Storage. `collections/*`, `indexes/*`, `data/*` and
`operation_status` are not deprecated and are not touched. The wider MDH V2 surface — `datasets`
CRUD, `v2/data/lookup` — is not adopted here.
