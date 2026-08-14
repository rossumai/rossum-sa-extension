# Partner onboarding training — live verification findings

Date: 2026-08-07
Environment: internal sandbox org `@mrtnzlml (SAND)` (id 214757) on `elis.rossum.ai` /
`api.elis.rossum.ai`. Read-only GETs plus one read-only POST probe. No customer org touched.
Method: Rossum API MCP client, and a browser session logged in by injecting the owner-supplied
token into `localStorage.secureToken`. No credential is recorded here, and no org content (names,
documents, dataset values) is reproduced — only structural facts.

Task 7 of `docs/superpowers/plans/2026-08-07-partner-onboarding-training.md`.

## Summary

| Gate | Question | Result |
| --- | --- | --- |
| G1 | Do Rossum nav items render as real `<a href>`? | **VERIFIED — yes** |
| G2 | Can a page-context fetch reach the API, and Data Storage? | **VERIFIED — both reachable** (first conclusion was wrong; see §G2) |
| G3 | Rules list shape for the delta check | **VERIFIED** |
| G3b | Schema nesting depth for `fieldCount` | **VERIFIED — forced a code change** |
| G4 | `auth/user` identity for the receipt | **VERIFIED** |
| G5 | `chrome.storage.onChanged` inside a content script | **VERIFIED — fires** (2026-08-08; it is what makes the card appear at all) |
| G6 | Routes the syllabus needs | **VERIFIED as a side effect of G1** |

Two gates changed the design. A third (G2) produced a wrong conclusion first, which is recorded
in full rather than quietly corrected — the mistake is more useful than the result.

## G1 — nav anchors (VERIFIED: yes)

The pointer arrow needs a durable handle on the element it points at. Observed hrefs in the live
dashboard:

```
/documents  /requests  /automation  /extensions/my-extensions  /statistics  /settings
/queues/<id>/settings/basic        /document/<id>
```

Rossum's navigation is built from **real `<a href>` elements**, and the hrefs match the route
contract `src/devtools/detect.js` already verifies. So `anchor: { hrefIncludes: … }` resolves, and
the three anchors in the syllabus (`/documents`, `/queues/`, `/extensions/my-extensions`) are all
present verbatim. The href-only anchoring rule stands — no CSS-class selector is needed anywhere,
which was the whole risk this gate existed to retire.

Tasks 10 and 11 are unblocked. The "no anchor ⇒ no arrow, step still completable" rule stays as
defence, but is no longer the expected case.

## G2 — page-context reachability (VERIFIED — corrected 2026-08-07)

**This section originally recorded a wrong conclusion. Kept visible rather than quietly rewritten,
because the error is instructive.**

What is true:

| Request (from a real page, page token) | Status |
| --- | --- |
| `GET /api/v1/schemas?page_size=1` (`Authorization: token …`) | **200** |
| `GET /svc/master-data-hub/api/v2/operation/` (`Bearer …`) | **200** |
| `POST /svc/data-storage/api/v1/collections/list` | **401** — route exists, auth rejected |
| `POST /svc/data-storage/api/v1/collections/list`, **no** auth header | **401** |

**Data Storage is deployed and reachable from the page origin.** The 401 is an auth-token-type
issue with the synthetic session used for probing (an API key was injected into
`localStorage.secureToken`, where DS expects the real session token the MDH app reads); a request
with no header at all returns the same 401, which is what an existing, auth-gated route looks like.
The shipping Dataset Management app calls exactly this URL with the page's session token and works.

### The error, and why it matters

I first probed two URLs I had constructed myself:

- `/svc/data-storage/api/v1/data/list_collections` — an endpoint name I invented
- `/svc/data-storage/collections/list` — the right endpoint, but missing the `/api/v1` segment

Both 404'd, and I recorded "DS is not deployed on this org" as **VERIFIED**. It was not verified; it
was two malformed requests. The authoritative answer was in the repo the whole time:
`src/mdh/api.js`'s `post()` builds `` `${serviceBase}/api/v1${path}` ``, i.e.
`/svc/data-storage/api/v1/collections/list`. I read `serviceBase` and stopped before reading the
function that uses it.

Two lessons recorded deliberately:

1. **A 404 from a URL you built yourself is evidence about your URL, not about the service.** Only a
   404 from a URL taken from working code is evidence about the service. The distinguishing probe —
   an unauthenticated request, to see whether the route 401s rather than 404s — costs one call and
   was not run.
2. **Read the client that works before probing the server.** The correct URL, method (POST) and auth
   scheme (`Bearer`, not `token`) were all sitting in shipping code.

### Consequences for the design

The check is restored. Mission 5's collection step returns to `kind: 'api'` with `collectionAdded`,
against the **correct** contract:

```
POST {origin}/svc/data-storage/api/v1/collections/list
Authorization: Bearer <page token>          ← NOT `token`, unlike /api/v1/
body: {"filter": null, "nameOnly": true}
```

Note this differs from every other check in the feature on three axes — method, auth scheme, and
path prefix — which is why it needs explicit support rather than reusing the GET helper.

`safeApiUrl`'s allowlist therefore **does** gain exactly one prefix, `/svc/data-storage/api/v1/`.
That is the one security-relevant line in this design, and it is now justified by a verified,
working endpoint rather than by an assumption.

## G3b — schema nesting (VERIFIED; forced a code change)

`GET /v1/schemas` lists (133 on this org). A schema's `content` nests deeper than one level:

```json
{ "category": "multivalue", "id": "line_items",
  "children": {                       // ← a single OBJECT, not an array
    "category": "tuple", "id": "line_item",
    "children": [ /* column datapoints */ ] } }
```

Both a header-level table (VAT rates) and the line-item table use this shape; the line-item table
alone held **11 column datapoints** below that object.

**Consequence.** The original `fieldCount` summed `content[].children.length`, scoring an entire
table as **one** field. A trainee adding a line-item column would move the count by **zero**, so
mission 2's "add a field" step could never tick — silently. `fieldCount` now walks the tree,
following `children` whether array or single object, counting every node with an `id` that is not a
section. Two tests added: nested columns are counted, and `grew()` fires when a column is added.

## G3 — rules list (VERIFIED)

`GET /v1/rules` lists for this role: `total` plus `results[]` with a **numeric integer** `id`, a
`name`, `enabled`, and numeric `queues[]`. `ruleIds()` works unchanged. This org carries 96 rules,
confirming the signature stays integers-only at realistic scale.

## G4 — receipt identity (VERIFIED)

`GET /v1/auth/user` returns a **numeric** `id`, a string `username`, and a `url` of the form
`…/users/<id>`. The receipt's canonical string uses the numeric id as designed; `mint.js`'s
url-parsing fallback is unnecessary here but stays as defence.

## G6 — routes (VERIFIED as a side effect of G1)

Every route the syllabus visits appeared as a real href during G1: `/documents`,
`/queues/<id>/…`, `/extensions/my-extensions`, `/document/<id>`. No new row is needed in
`detect.js`, so its "never add a route from memory" rule is not engaged.

One observation worth carrying into the syllabus: the dashboard **redirects to a filtered
`?level=queue` view** by default (a saved filter), not `?level=all`. Mission 1's first step matches
`level=all` → organization, which is a deliberate navigation the trainee must perform. That is
still a fair step, but the hint should make it explicit rather than assuming the default landing
already satisfies it.

## G5 — `chrome.storage.onChanged` in a content script (NOT VERIFIED — deliberately)

The extension loads in the automated browser, but `agent-browser eval` runs in the page's **main
world**, and a content script runs in an **isolated world**. The page world therefore cannot
observe the listener. Verifying this properly needs either a temporarily instrumented build or a
devtools extension-context probe.

Not pursued, on a cost/stake judgement: the entire stake is whether a trainee must press F5 once
after unlocking. **Both outcomes are already safe in the design** — `onUnlockChange` is additive,
and if it never fires the card simply appears on the next page load, which is the documented
fallback. This is recorded as an open question rather than an assumption: if the card ever fails to
appear on unlock without a reload, this is the reason, and the fix is a one-line reload prompt.

## What this changes in the plan

- Task 2 corrected for G3b (recursive `fieldCount`).
- Tasks 10, 11, 12 unblocked (G1): the pointer can anchor by href.
- Mission 5's collection step stays `kind: 'api'` with `collectionAdded`, against the corrected
  contract in §G2 — POST, `Bearer`, `/svc/data-storage/api/v1/collections/list`.
- `safeApiUrl` gains exactly one prefix, `/svc/data-storage/api/v1/`. Because that check is the only
  caller and it is a POST with a different auth scheme, it needs an explicit second helper rather
  than reusing the GET path — see Task 8.
- Mission 1's first step should say explicitly that the trainee must switch to the all-documents
  view; the dashboard's default landing is a filtered `?level=queue`.

## G7 — list paging on `api` checks (CLOSED — no live gate remains)

Added 2026-08-08 while fixing the whole-branch review's finding I4; **closed the same day** by the
re-review, which correctly rejected the first fix. The reasoning is kept rather than deleted, because the
rejected approach is the one a future reader is most likely to reach for again.

### The defect

`page_size=100` silently stranded `api` steps on any org past the first page: Rossum list endpoints
order by id ascending, so a newly created rule on an org with ≥100 rules lands on the **last** page and
the delta never fires. Not hypothetical — the org probed for this feature carries **96 rules and 133
schemas**, so the schema check was already counting only the first 100.

### The rejected fix — `&ordering=-id` on the id-delta checks

Wrong on two counts, and both are worth remembering:

1. **It made `thresholdChanged` worse, not better.** `changed()` only fires for a queue present in
   *both* snapshots, and that step's own teaching text says "we confirm the value moved **on a queue
   that already existed**" — i.e. it points the trainee at old queues, which are exactly the ones
   newest-first drops. The ascending default at least covered the *oldest* 100. A partial gap became a
   targeted one.
2. **It was never verifiable.** Django REST Framework **ignores an ordering field it does not expose**,
   falls back to the default order, and the stranding returns with no error anywhere — so a wrong guess
   would have been invisible in production and in tests alike. That left this gate open on an unprobed
   query parameter.

It also left an unresolved trade on `hookAttachedToQueue`: newest-first catches a *newly created* hook
being attached but misses an **existing** hook gaining a queue if that hook sits past page 1; ascending
has the mirror-image flaw, and the step's wording permits either.

### The shipped fix — read every page, order nothing

`ordering` is gone from every check. All four `/api/v1/` checks (`ruleCreated`, `hookAttachedToQueue`,
`thresholdChanged`, `schemaFieldAdded`) carry `paginate: true`, and `steps.js collectResponses` follows
`pagination.next` to the end (capped at 50 pages; absolute `next` urls reduced to path+query, since the
content script's `safeApiUrl` allowlist rejects absolute urls and the Academy's fetcher prefixes the
domain).

**This closes the gate rather than moving it.** `pagination.next` is not a guess: it is the contract
`src/galaxy/api.js` `listAll` already follows in shipping code. Reading every page also dissolves the
`hookAttachedToQueue` trade outright — with all pages in the signature there is no old-vs-new choice
left to make.

Cost on the probed org: rules 1 page, queues 1, hooks 1, schemas 2 — **one extra GET**, and only while
the step that needs it is the current one.

Guarded by `tests/training-steps.test.js` → `paging strategy`, which asserts every check paginates, that
**no** check carries an `ordering` parameter, and — the regression that motivated all of this — that
`thresholdChanged` still detects a threshold move on an **old** queue sitting on page 2.


# Live end-to-end verification (2026-08-08, fresh token)

Extension loaded unpacked into a real Chrome, real session on the internal sandbox org. Two verified
contexts used throughout: a Rossum tab, and an extension page for `chrome.storage` writes.

## VERIFIED — the card appears when a track starts, with no reload

The scenario that was **broken until the whole-branch review** (finding C1): gate unlocked, no track,
Rossum tab already open.

| Step | Observed |
| --- | --- |
| Gate unlocked, no track | **no card** (correct) |
| Track written from the *extension* context, as the Academy does | — |
| Same Rossum tab, **no reload**, 5 s later | **card rendered**, mission 1 listed |

This simultaneously closes **G5**: `chrome.storage.onChanged` **does** fire inside a content script.
That gate was earlier skipped as "low stakes — one F5". It was not: the fix for the feature-breaking
C1 defect is built on exactly that event, so the whole feature's first-run behaviour depends on it.

## VERIFIED — the pagination fix, against real data

`GET /api/v1/schemas?page_size=100` returns `total: 133`, `returned: 100`, and a `pagination.next`
that is an **absolute URL carrying an opaque cursor**:

```
https://elis.rossum.ai/api/v1/schemas?cursor=eyJwb3NpdGlvbiI6…&page_size=100
```

Network capture during a live mission-2 check shows both requests — the first page **and the cursor
follow-up**. So `collectResponses` really does page, and `relativePath` really does reduce an absolute
cursor URL to a path without losing the cursor. The >100 stranding this fixed was real, not theoretical:
this org has 133 schemas and one page holds 100.

## VERIFIED — Data Storage contract

`POST /svc/data-storage/api/v1/collections/list` with `Bearer` → **200**, body
`{"code":"ok","message":"","result":[…]}`. **`result`, singular** — confirming the `collectionCount`
fix live. The earlier 401 was an expired token, not an auth-scheme problem.

## VERIFIED — no mutating request

Full network capture over a complete check cycle: **64 GET, 11 POST**. Every POST belongs to Rossum's
own SPA or a third party (Sentry, `annotations/search`, `billing_stats`, otel, prometheus, GA).
**Zero PUT, PATCH or DELETE from any source**, and no POST attributable to the extension.
Scope note: this window exercised mission 2's check. Mission 5's Data Storage POST is a documented,
intentional read and was verified separately above.

## NEW DEFECT — `m1.s2` is satisfied by the landing page

`detectResource` maps the **default filtered dashboard** —
`/documents?filtering={…queue…}&level=queue` — to `{type:'queue', id:…}`, a descriptor **identical in
shape** to a real `/queues/{id}` visit. `m1.s2` targets `{type:'queue', detail:true}`, so it ticks
without the trainee opening a queue.

Observed directly: with progress cleared, `m1.s1` **and** `m1.s2` both went `passed` within ~2 s while
the tab sat on `/documents`. Since the dashboard *defaults* to that filtered view, effectively every
trainee gets `m1.s2` free on first load.

Not dangerous — it is a navigation step, not evidence of work — but it is the same "credit for
something you did not do" class the mission-start baseline exists to prevent, and the step's hint
("Open any queue") then describes something that did not happen.

The two cases are indistinguishable downstream, so a fix needs a discriminator the descriptor does not
currently carry — e.g. an optional `pathStartsWith: '/queues/'` on the visit target, checked alongside
`type`. Left for the owner: it is a curriculum-semantics decision (does "the dashboard filtered to one
queue" count as opening a queue?) and the syllabus is theirs.

## Method note

Three probes in this session were mis-built before producing a usable answer: `agent-browser tab 4`
is not valid (`t4` is), so tab switches silently did nothing and readings came from the wrong context —
twice reporting "no card" for a tab that was never the one under test. Same failure shape as the
`/svc/data-storage` 404s recorded in §G2: **a negative result from an unverified probe is a fact about
the probe.** Every conclusion above was re-taken with the context asserted (`location.host` /
`location.protocol`) immediately before the measurement.

## VERIFIED — the `data-cy` anchor harvest (2026-08-14, elis)

Anchor coverage went from **3 of 20** steps to **16 of 20**. Every value was read off the live
screen it belongs to, then re-checked by running `resolveAnchor`'s own logic (cy-first, then
`hrefIncludes`) against that screen's DOM and asserting the element was found *and* visible
(`getBoundingClientRect().width > 0`). Reading a value out of a DOM dump only proves it exists
somewhere; running the shipped resolver proves the feature will find it.

| Step | Anchor | Screen | Resolved as |
|---|---|---|---|
| m1.s1 | `all-documents-sidebar` + `/documents` | dashboard | `DIV` "All documents" (href elsewhere) |
| m1.s2 | `sidebar-queue` + `/queues/` | dashboard | `DIV` queue name |
| m1.s3 | `document-row` | dashboard | `DIV` first row |
| m1.s4 | `annotation-sidebar-datapoint` | annotation | `LI` field |
| m2.s1 | `queue-settings-header-tab-fields` | queue settings | `BUTTON` "Fields" |
| m2.s2 | `add-field-button` | Fields tab | `A` "Add field" |
| m2.s3 | `/settings/field-manager` | `/settings` **only** | `A` "Field manager" |
| m3.s1 | `extensions-navtab` + `/extensions/my-extensions` | any | `A` "Extensions" |
| m3.s2 | `extensions-table-row` | Extensions list | `LI` |
| m3.s3 | `queue-multi-select` | extension detail | `DIV` |
| m3.s4 | `extensions-activities-button` | extension detail | `A` |
| m3.s5 | `/queues/` | queue screens | `A` queue name |
| m4.s1 | `tab-automation.aiEngines` | AI engines | `BUTTON` "AI engines" |
| m4.s2 | `add-rule-button` | Rules tab | `BUTTON` "Add rule" |
| m4.s3 | `automation-level-confident` | Automation tab | `LABEL` "Confident" |
| m4.s4 | `confirm-annotation-btn` | annotation | `BUTTON` "Confirm" |

### The values follow no single scheme — this is the gate that stays open

`queue-settings-header-tab-fields` vs `tab-automation.aiEngines` vs `extensions-add-extension` vs
`fm-add-field-btn`: four naming conventions across four sections, and the Automation one contains a
**dot**. Extrapolating a fifth from these would produce a selector that never resolves, and an
unresolved anchor renders nothing — so the failure is *silent*, indistinguishable from "this step
has no anchor". Anyone extending the curriculum must harvest against the live screen.

The dot is handled on both code paths, for different reasons: Chrome's `CSS.escape` emits `\.`,
which a **quoted** attribute selector reads back as a literal dot (verified live); jsdom has no
`CSS.escape`, so the fallback leaves the dot unescaped, which is already inert inside that same
quoted selector. jsdom therefore cannot cover Chrome's path — hence the live check, with the
fallback pinned by `tests/training-tether.test.js`.

### Two findings that changed the curriculum

1. **`hrefIncludes: '/queues/'` points at the wrong thing on the dashboard.** The only `/queues/`
   link there is the queue's **settings gear** (`/queues/<id>/settings/basic`) — a different
   destination than "Open any queue". `m1.s2` now prefers `cy: 'sidebar-queue'` and keeps the href
   only as a fallback for screens without the sidebar.
2. **Field Manager has no per-field handle.** ~1481 elements, **4** distinct `data-cy` values
   (`header-title`, `fm-add-field-btn`, `fm-queues-dialog-link`, `wrapper`). So `m2.s3` anchors the
   link *into* Field Manager — which resolves on `/settings` and nowhere else, confirmed by probing
   `/settings/field-manager` itself and getting no match — and `m2.s4` stays unanchored rather than
   pointing at something adjacent to what it asks for.

### Unchanged, and still open

`/documents` normalises to a `level=queue` view, so `m1.s2` can still tick without the trainee
opening a queue (§ "NEW DEFECT" above). The harvest confirms the cause but does not fix it: the
anchor now points at the right control, while the *pass condition* remains `detectResource`'s.
