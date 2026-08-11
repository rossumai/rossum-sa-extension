# Gamified partner onboarding training (quest log, Academy, completion receipt)

Date: 2026-08-07
Status: design approved; not implemented

## 1. Goal

Onboarding a new implementation partner onto Rossum is today an unstructured,
human-led activity. This design adds a guided, self-paced training track to the
extension that:

1. **Guides** a partner through the parts of Rossum they must know, in order.
2. **Verifies** that they actually got there and actually did the thing —
   from the URL they reached and from read-only API state, never from
   click-tracking.
3. **Rewards** progress visibly (XP, levels, per-mission badges) so a track is
   finishable rather than abandoned.
4. **Issues a completion receipt** carrying a per-person code the trainee
   presents to us, which we can validate without a backend.

Explicit **non-goals**: this is not a certification authority, not a
tamper-proof credential, and not a customer-facing product surface. It is a
training aid whose receipt deters casual copying between trainees (§7.4).

The first audience is **implementation partners**, working in **whatever org
they happen to have** — no seeded objects may be assumed.

## 2. Verified facts this design rests on

Everything below was read from source or probed live in this session. Nothing
here is recalled or assumed.

| Fact | Source |
| --- | --- |
| A content script on a Rossum origin can read `localStorage.secureToken` and call the same-origin API with `Authorization: Token` | `src/rossum/api.js`, used by `resource-ids.js` |
| That client's `apiCache` **never expires** — a path fetched once is never re-fetched for the life of the page | `src/rossum/api.js` |
| Its `safeApiUrl` guard hard-restricts paths to `/api/v1/`, rejecting `..`, `//`, schemes and absolute URLs | `src/rossum/api.js` |
| SPA route changes are caught with a plain 1.5 s `location.pathname` poll — no History hooks needed | `src/rossum/features/track-viewed.js` |
| `src/devtools/detect.js` is a **pure** module exporting `detectResource(location)` + `ROUTES`, with per-row live-verified routes for queue, hook, user, schema, engine, rule, annotation, the hooks/users/labels list pages, `documents?level=all` → organization, and the queue Emails/Fields tabs | `src/devtools/detect.js` |
| That file's header forbids adding routes from memory: they "arrive via the live-verification task" | `src/devtools/detect.js` |
| A fixed-position card injected over a Rossum page, with prefixed CSS, `textContent` only (no `innerHTML`, Trusted-Types-safe) and a `sessionStorage` dismissal, is an already-shipping pattern | `src/rossum/features/dataset-mgmt-suggest.js` |
| A dependency-free pure module can be bundled into **both** the content script and the Console without dragging signals along | `src/inspector/viewed.js` |
| `experimentalUnlocked` is written by 5 quick clicks on the popup version hash, **toggles** (5 more clicks re-hide), is written straight to `chrome.storage.local`, and needs **no tab reload** — the Console mirrors it via `chrome.storage.onChanged` | `src/popup/components/App.jsx` `onVersionClick`, `src/console/index.jsx` |
| `createUnlockCounter({threshold, windowMs})` is a pure, reusable factory that owns no storage and no UI | `src/popup/experimental.js` |
| `experimentalUnlocked` today gates **exactly one thing — Mr. Fabry** | `src/console/components/Rail.jsx` (`exp: true` on the `fabry` row only) |
| Inside Fabry, `implementAllowed` and `deepVerifyAllowed` both default to `true`, so the write-enabled Architect implement loop is on for anyone who unlocks | `src/fabry/store.js` |
| Adding a Console app touches exactly four files: `Rail.jsx` `APPS`, `Console.jsx` render switch, `boot.js` (`isValidApp`, `pickInitialApp`, `appAfterGateChange`), and `console/index.jsx` (`TITLES`, `APP_EVENTS`, `ensureInited` + an `<app>Inited` flag, auth wiring) | those files |
| `crypto.subtle` HMAC-SHA256 works in this context: 32-byte digest, `isSecureContext === true` | live probe, 2026-08-07 |
| Manifest permissions are `storage`, `activeTab`, `scripting`, `sidePanel`; `host_permissions` cover the Rossum hosts, `localhost:3000` and `*.rossum.cloud` | `manifest.json` |
| Console CSS has migrated to CSS Modules: `src/console/console.css` ships as `dist/console/console.base.css` and esbuild emits `dist/console/console.css` from imported `*.module.css` files | `build.js`, `src/ui/*.module.css` |
| The usage vocabulary is closed: an event name must exist in `src/usage/event.js` **and** in `PRIVACY.md`, enforced by tests | `src/usage/event.js`, `tests/usage-boundary.test.js` |
| Storing an org `origin` in `chrome.storage.local` is an established pattern | `src/inspector/viewed.js` (`rossumViewedAnnotations`) |

Two consequences drive the design:

- **No manifest change.** Per this repo's own recorded finding (see the usage
  measurement spec, §2), adding a permission disables every existing install
  until each user re-approves. Everything below fits inside the permissions
  already granted.
- **Unlocking training must not unlock Fabry.** Because `experimentalUnlocked`
  gates the write-capable Architect implement loop, training gets its **own**
  key (§9).

## 3. Decisions

| Decision | Choice |
| --- | --- |
| Audience (v1) | Implementation partners |
| Org | Any org; no seeded objects assumed |
| In-page surface | Corner card, bottom-right, collapsible (variant A of the visual preview) |
| Guidance | Pointer-only — an arrow at the target, teaching text in the card (variant C) |
| Academy | Built: a 6th Console app |
| Receipt validation | Trainer panel inside the Academy |
| Gate | New `trainingUnlocked` key, same 5-click mechanic, different click target |
| Progression | Linear — each mission unlocks the next |
| Rewards | XP + levels + per-mission badges |
| Curriculum | Bundled pure data; v1 drafted here for owner correction |
| Org writes by the extension | **None.** Every verification is a read |

## 4. Architecture

### 4.1 Surfaces

| Surface | Runs in | Responsibility |
| --- | --- | --- |
| Quest log card | Rossum content script | Live checklist, XP/badges, pointer arrow, continuous evaluation |
| Academy | Console page (`console/console.html`) | Mission map, teaching text, receipt, trainer panel, mint-time re-verification |
| Popup | Popup | The 5-click unlock + a "Training" entry point |

Both evaluating surfaces run the **same pure evaluation code**, each injecting
its own `get(path)` — the content script's same-origin fetch, the Console's
`host_permissions` client. The logic cannot diverge because there is only one
copy of it. Progress is exchanged through `chrome.storage.local`, which both
surfaces already have; no runtime messaging is introduced.

### 4.2 Module layout

```
src/training/            pure core, dependency-free (bundles into BOTH surfaces)
  track.js               curriculum DATA only — missions, steps, hints, teaching text
  steps.js               pure evaluation: (step, context) → passed?
  baseline.js            pure snapshot signatures + delta predicates
  progress.js            pure state merge, XP/level math, linear unlock, version migration
  receipt.js             pure canonical string, code formatting, receipt parsing
  hmac.js                the only impure crypto: crypto.subtle wrapper
  receiptKey.js          the HMAC secret, isolated (the ga4Config.js precedent)
  storage.js             chrome.storage keys + read/write helpers
  gate.js                trainingUnlocked read + onChanged subscription

src/rossum/features/training-quest.js   card + arrow + polling loop
src/academy/                            index.jsx, store.js, components/
```

`track.js` holds **no logic** and `steps.js` holds **no data**, so the syllabus
can be rewritten without touching evaluation, and evaluation can be tested
without the syllabus.

The Academy introduces no new auth path: it reuses the existing single-use
`consoleAuth_<uuid>` staging and the per-tab `sessionStorage` credentials the
Console already resolves at boot, and is lazily started by an `initAcademy()`
added to `ensureInited` with its own `academyInited` flag — the same shape as
`initGalaxy`/`initInspector`/`initFabry`.

### 4.3 Data flow

```
content script                          chrome.storage.local            Console (Academy)
──────────────                          ────────────────────            ─────────────────
route poll (1.5 s)  ┐                                                   renders progress
api poll (≤ 20 s)   ├─→ steps.js ─→ progress.js ─→ trainingProgress ←──→ (onChanged, live)
"Check now" button  ┘                        ▲                          "Re-check" → same
                                             │                          pure path, own get()
                                             └──────────────────────────  mint: re-verify all
```

## 5. Verification model

### 5.1 Step kinds

```js
// track.js — shape only; real content in §8
{ id: 'm3.s1', kind: 'visit',  target: { type: 'hook', detail: false },
  hint: 'Left nav → Extensions.', teach: '…markdown…',
  anchor: { hrefIncludes: '/extensions/my-extensions' } }

{ id: 'm3.s3', kind: 'api',   check: 'hookAttachedToQueue', hint: '…', teach: '…' }

{ id: 'm3.s4', kind: 'self',  hint: '…', teach: '…' }
```

- **`visit`** — evaluated by `detectResource(location)` from `src/devtools/detect.js`.
  `type` must match; `detail: true` additionally requires the descriptor to carry
  an `id` (a detail route), `detail: false` requires it not to (a list route).
  One live-verified route table now serves both
  the DevTools panel and training. A step needing a route not in that table is
  blocked until the route is live-verified and added there, per that file's rule.
- **`api`** — a named check in `steps.js`:
  ```js
  { id: 'hookAttachedToQueue',
    fetch: (get) => get('/api/v1/hooks?page_size=100'),
    signature: (data) => /* integers only */,
    pass: (sig, baselineSig) => /* delta in the required direction */ }
  ```
- **`self`** — trainee ticks it. Stored as a distinct state and **printed on the
  receipt as self-attested**, so it is never mistaken for evidence.

### 5.2 Baseline and delta — why it is not optional

The track must work in any org, including one that already contains the object a
step asks the trainee to create. Therefore each mission captures a **baseline
signature when it starts**, and an `api` check passes only on a *delta*: an id
that was not there before, a collection whose count grew, a threshold whose value
changed. Without this, a partner with a mature sandbox gets free ticks and the
receipt means nothing.

**Baselines contain integers only** — numeric ids, counts, thresholds and
`hookId:queueId` pairs of numeric ids. No names, no schema-field strings, no
collection names, no document data ever enters the baseline. Where a delta would
otherwise need a name (e.g. "a new Data Storage collection"), the signature is a
**count**.

### 5.3 Polling discipline

Everything is idle until a mission is active and the gate is unlocked.

| Trigger | Cadence |
| --- | --- |
| `visit` checks | piggyback on a 1.5 s `pathname` compare (the `track-viewed` pattern) |
| `api` checks | only while the current step is `api`-kind; at most every 20 s |
| Tab focus | one immediate `api` evaluation |
| "Check now" button | one immediate evaluation |

One required change to the API client, additive:

1. Add `fetchRossumApiFresh(path, { ttlMs = 10_000 })` beside the existing
   `fetchRossumApi` in `src/rossum/api.js`, with in-flight dedupe and a short
   TTL. The permanent-cache function is left byte-identical so ID overlays are
   unaffected. Rationale: one module keeps owning token handling and URL safety.

**`safeApiUrl` is NOT widened.** An earlier draft widened it by one prefix for a
Data Storage check. Live probe 2026-08-07: DS is not deployed on every org, so
that step became `self` and the widening lost its justification. The allowlist
stays `/api/v1/` alone — the only prefix this feature needs, and verified live
from a page context (`fetch('/api/v1/schemas?page_size=1')` with the page token
returns 200). The design therefore contains **no** security-relevant change.

### 5.4 Pointer anchoring

The arrow is positioned from `document.querySelector('a[href*="…"]')` using the
step's `anchor.hrefIncludes` — **hrefs only, never CSS classes**. The href
contract is the same one `detect.js` already verifies; class names are not a
contract this repo owns, and the existing DOM-coupled features are already its
maintenance hotspots.

Rules, in order of importance:

1. If no anchor resolves within ~2 s (a few retries with backoff, since the SPA
   renders asynchronously), **no arrow renders**. The step is still completable
   from the card's text hint. A stale anchor must never block a trainee.
2. The arrow is `pointer-events: none` and never covers the target.
3. Position is refreshed on `scroll`/`resize` via a rAF-throttled handler, and
   torn down on step change.
4. A step with no durable anchor simply omits `anchor`.

## 6. Progress state and storage

One additive key, `trainingProgress`:

```js
{
  "https://partner-sandbox.rossum.app": {
    trackId: 'partner-foundations', trackVersion: 1,
    startedAt: 1786109630000, xp: 240,
    missions: {
      m2: { startedAt: …, baseline: { queueIds: [...], hookQueuePairs: [...] },
            steps: { 'm2.s1': { state: 'passed', at: … },
                     'm2.s4': { state: 'self',   at: … } } }
    },
    receipt: { code: 'RSA1-…', issuedAt: …, … }   // present once minted
  }
}
```

- Keyed by **origin**, the established `rossumViewedAnnotations` pattern. Capped
  to the 3 most recently used orgs.
- Steps are **monotonic** — a passed step stays passed — except during mint-time
  re-verification (§7.3), which is the one place a pass can be revoked.
- Both surfaces write it; writes are per-step merges, so a concurrent write from
  the other tab cannot clobber unrelated state.

**Track version migration.** When a shipped curriculum changes, `progress.js`
reconciles on read: step ids that still exist keep their state, unknown ids are
dropped, mission completion and XP are recomputed, and an existing receipt is
marked **stale** (shown as "issued against track v1; the track is now v2")
rather than silently revalidated.

**XP and levels** are pure data in `progress.js`, tunable without touching logic:
`visit` 10 XP, `api` 25 XP, `self` 10 XP, +50 per completed mission; level
thresholds as an array. One badge per completed mission. The v1 track (§8)
totals 525 XP.

**Reset.** The Academy offers "Restart track" (this org only, local only) — a
demo and re-run affordance, not a hidden state.

## 7. Receipt, code and trainer panel

### 7.1 Canonical string

```
RSAT1|<trackId>@<trackVersion>|<origin host>|<user id>|<missions passed, csv>|<self-attested count>|<YYYY-MM-DD UTC>
```

`user id` is the numeric id from `/api/v1/auth/user/` (§10.4); the username is
**printed** on the receipt for the human check but is not part of the digest.

### 7.2 Code

`HMAC-SHA256(key, canonical)` → Crockford base32 (no I/L/O/U, so transcription
errors are near-impossible) → first 16 chars → `RSA1-XXXX-XXXX-XXXX`.

`receipt.js` stays pure by taking an injected digest function; `hmac.js` is the
only module that touches `crypto.subtle`; `receiptKey.js` is the only module
that names the secret.

### 7.3 Minting

"Issue receipt" appears once every mission is complete. Minting **re-runs every
`api` check against live org state**. If a check no longer passes, no receipt is
issued and the step returns to open, with an explanation. This is what makes the
code reflect the org rather than local storage.

### 7.4 Honest limits — stated in the spec, in the UI, and in `PRIVACY.md`

- The HMAC key ships inside the bundle and is extractable, exactly as the GA4
  API secret already is. This deters copying between trainees; it is not proof
  against a determined forger.
- `chrome.storage.local` is editable in DevTools. Mint-time re-verification
  means forging requires either extracting the key or actually doing the work in
  a real org.
- `self` steps are self-attested by construction and are counted separately on
  the receipt.
- Two trainees in the **same org** get different codes (the user id is in the
  digest); a code presented by the wrong person or from the wrong org fails.

### 7.5 Trainer panel

A "Validate a receipt" section in the Academy: paste the **whole receipt block**,
which is parsed strictly (exact field order, no whitespace tolerance beyond
trimming), recomputed, and answered valid/invalid plus the org host and user id
it was issued to. It shares `receipt.js` with the minting path, so mint and
check can never disagree.

The panel is an oracle only for codes the holder could already compute (the key
is in their bundle), so it adds no attack surface.

## 8. Curriculum v1 — strawman for owner correction

Linear, 5 missions, 20 steps, 525 XP. `url` = route match, `api` = delta check,
`self` = attested. **This is a draft written from the topics the repo's own
`rossum-sa` skill packs cover; the owner is expected to rewrite it.**

| M | Mission | Step | Kind | Verification |
| --- | --- | --- | --- | --- |
| 1 | Orientation | Documents dashboard | url | `documents?level=all` → organization |
| | | Open a queue | url | queue detail route |
| | | Open an annotation | url | annotation route |
| | | Find a field's `schema_id` | self | — |
| 2 | Queues & schema | Queue Fields tab | url | queue Fields route |
| | | Add a field to the schema | api | org-wide schema field **count** grew vs baseline |
| | | Field Manager detail | url | schema detail route |
| | | Locate a formula field | self | — |
| 3 | Extensions | Extensions list | url | hooks list route |
| | | Open an extension | url | hook detail route |
| | | Attach it to a queue | api | a new `hookId:queueId` pair vs baseline |
| | | Read its execution log | self | role-dependent — deliberately not API-verified |
| | | Back to the queue | url | queue detail route |
| 4 | Automation & rules | Engines page | url | engine route |
| | | Create a rule | api | a rule id absent at baseline |
| | | Change a score threshold | api | `default_score_threshold` value changed |
| | | Confirm a document | self | role- and content-dependent |
| 5 | Master data | Open Dataset Management | self | Console app, not a Rossum route |
| | | Create a collection | api | collection **count** grew (names never stored) |
| | | Run a query | self | — |

Execution logs and document confirmation are `self` on purpose: both are
role-dependent, and a step that 403s for a trainee is worse than an honest
checkbox.

Each step also carries a one-line plain-text `hint` (rendered in the card, no
markup) and a markdown `teach` block (rendered in the Academy by the existing
hand-rolled renderer, `src/ui/fabry/markdown.js`).

## 9. Gate

New key **`trainingUnlocked`**, independent of `experimentalUnlocked`.

- **Trigger**: a second `createUnlockCounter` instance bound to the **extension
  name in the popup header**. Toggles, like the existing unlock, and shows the
  same style of transient notice. The choice of target is cosmetic and
  swappable; what matters is that it is *not* the version hash, so the two
  unlocks stay independent.
- **Popup**: while unlocked, a "Training" section offers Start / Continue /
  Open the Academy.
- **Content script**: reads the key at init and subscribes to
  `chrome.storage.onChanged` (§10.5), so unlocking makes the card appear with no
  tab reload — matching how the Fabry rail item already behaves. While locked,
  the feature costs one storage read and one listener; no observer, no polling,
  no DOM.
- **Console**: a `trainingUnlocked` signal mirrored exactly like
  `experimentalUnlocked`, including the re-lock fallback to `mdh`.

Rationale for a separate key is in §2: `experimentalUnlocked` gates Mr. Fabry,
whose Architect implement loop defaults to write-enabled, and a partner trainee
must not acquire an autonomous write capability against their org as a side
effect of starting training.

## 10. Live-verification gates (before implementation)

Each becomes a task in the plan. None may be assumed.

1. **Nav anchors.** Do Rossum's left-nav items render as `<a href>` matching the
   verified routes? Decides §5.4. Degrades to "no arrow" if not.
2. **Data Storage same-origin.** Is `${origin}/svc/data-storage/…` reachable
   from a content script with the page token? Gates the §5.3 allowlist widening
   and mission 5.
3. **Rules list shape.** Confirm the list endpoint and that ids are numeric, for
   the mission-4 delta check.
3b. **Schemas list.** Confirm `/api/v1/schemas?page_size=100` returns
   `results[].content[].children` for a normal role — the mission-2 field-count
   delta reads it org-wide rather than resolving the trainee's current queue.
4. **`/api/v1/auth/user/`.** Confirm a stable numeric `id` and a `username`, for
   the receipt.
5. **`chrome.storage.onChanged` in a content script.** Cheap probe; it is what
   makes the no-reload unlock work. Fallback: read at init only, and the card
   appears on the next page load.
6. **Any new route** the final syllabus needs is added to `detect.js` **only**
   after live verification, per that file's own header rule.

## 11. Backward compatibility

- **No manifest change** — no permission is added, so no existing install is
  disabled.
- **New storage keys only** (`trainingUnlocked`, `trainingProgress`). Absent
  means off / not started; nothing is migrated, and an older build simply
  ignores them.
- `fetchRossumApi` keeps its exact current behaviour; the fresh variant is
  additive.
- `detect.js` gains no rows except live-verified ones; `detectResource`'s
  signature is unchanged.
- `pickInitialApp` gains an **additive** optional `academyUnlocked = false`
  parameter beside the existing `fabryUnlocked`, exactly as `fabryUnlocked` was
  itself added. Older call sites and the existing "default locked (older
  callers)" test keep passing untouched. (An `unlocked: {…}` object refactor was
  considered and rejected: it churns three test call sites for no behavioural
  gain.)
- Curriculum changes ride a Chrome release (days of review). Accepted: it is
  bundled data, which is what makes it offline, versioned and testable.

## 12. Privacy invariants

- The extension **never writes to the org**. Every verification is a read — but note
  that "a read" is not synonymous with "a GET": the Data Storage check is a `POST`
  carrying a query body (that service's read API works that way, like a Mongo
  `find`) and lists collection names without changing anything. The invariant is
  *no mutation*, and it should be audited against mutating verbs and endpoints
  rather than against the HTTP method alone.
- Baselines hold **integers only** (§5.2). No names, no field ids, no collection
  names, no document data.
- The receipt contains the org host, a numeric user id, a username, mission
  counts and a digest — nothing about the org's contents. It leaves the browser
  only when the trainee sends it to us.
- No org host, user id or code is ever attached to a usage event; the vocabulary
  has no key for it (`src/usage/event.js`).
- Progress is local. Nothing is written to Data Storage or any Rossum object.

## 13. Usage events

Five additions to the closed vocabulary, each also added to `PRIVACY.md` in the
same change (test-enforced pairing), all **parameterless**:

`sa_training_start`, `sa_training_mission_complete`,
`sa_training_receipt_issue`, `sa_training_receipt_verify`,
`sa_console_app_academy`.

Deliberately no mission index and no step id: the question these answer is "is
the training feature used at all", and a per-step funnel would be exactly the
per-user reconstruction the usage design rules out.

## 14. Testing

Vitest, following the repo's `.test.js` + `h(Component, null)` convention.

| Target | Test |
| --- | --- |
| `steps.js` | each check's `pass` against synthetic before/after signatures, incl. the no-change case |
| `baseline.js` | signatures contain integers only (a guard test asserting no strings leak in) |
| `progress.js` | XP/level math, linear unlock, monotonicity, track-version migration |
| `receipt.js` | canonical string stability, code formatting, strict parse, round-trip mint→verify with a fake digest |
| `hmac.js` | known-answer HMAC vector |
| `track.js` | curriculum integrity: every step references a known check id and a route type `detect.js` actually returns |
| Key boundary | only `src/training/receiptKey.js` may name the secret — asserted against `src/` **and** built `dist/`, mirroring `tests/usage-boundary.test.js` |
| Gate | locked ⇒ no card injected, no polling, no rail item; re-lock while Academy is active falls back to `mdh` |
| Pointer | unresolvable anchor ⇒ no arrow, step still completable |

## 15. Build order

Each phase is independently useful and independently testable:

1. **Pure core** — `track.js`, `steps.js`, `baseline.js`, `progress.js`,
   `receipt.js`, `hmac.js` with their tests. No UI, no chrome APIs.
2. **Live-verification gates** (§10). Their answers may amend the syllabus and
   the anchor strategy, so they land before any UI.
3. **Gate + popup** — `trainingUnlocked`, the second unlock counter, the popup's
   Training section.
4. **Quest log** — the corner card, the polling loop, the pointer.
5. **Academy** — the Console app, mission map, teaching text, receipt, trainer
   panel.
6. **Usage events + `PRIVACY.md`**, in one change to satisfy the paired test.

## 16. Out of scope

- Spotlight/dim overlays and click-blocking coach marks (variant B, declined).
- Remote-hosted curriculum.
- Server-issued or server-validated codes.
- Any write to the trainee's org, including scaffolding a training sandbox.
- Tracks for customers or Rossum employees — the format supports more tracks,
  but v1 ships one.
- Multi-device progress sync.
