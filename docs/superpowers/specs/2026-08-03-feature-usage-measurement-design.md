# Feature usage measurement (opt-in, GA4 Measurement Protocol)

Date: 2026-08-03
Status: implemented (staged, uncommitted); GA4 property configured and live-verified

## 1. Goal

Nobody — including the authors — currently knows which of this extension's
features are used. Effort is therefore allocated by guesswork, and features that
nobody opens keep being maintained. This design adds the smallest honest
mechanism that answers three questions:

1. **Prune** — which features is nobody using?
2. **Prioritise** — of the used ones, which are leaned on hardest?
3. **Prove adoption** — how does per-feature use trend over time?

Explicit **non-goal**: reconstructing what an individual person did. No funnel
analysis, no session replay, no per-user reports, no ordered action timelines.
The framing given to users is the true one: *not tracking anyone — deciding
together which features are actually used and useful.*

## 2. Verified facts this design rests on

Everything below was checked, not assumed.

| Fact | Source |
| --- | --- |
| No telemetry exists in the extension today; the only non-Rossum external host referenced in `src/` is `rossum-agent-api.tools.rossum.cloud` (`src/agent/agentApi.js`) | `rg` over `src/` |
| Live listing `bljkbinljmhdbipklfcljongikhmnneh` (publisher `mrtnzlml`) shows **"108 users"**, 5.0★/2 ratings, **no privacy-policy link**, and its privacy section states the developer **has disclosed it will not collect or use user data** | Chrome Web Store listing page |
| MV3 extensions must use the **GA4 Measurement Protocol**; `gtag.js` is remote code and banned. Endpoints: `https://www.google-analytics.com/mp/collect` and `.../debug/mp/collect`. Needs a measurement ID + API secret + a client ID persisted in `chrome.storage.local` | developer.chrome.com "Use Google Analytics" |
| That guide's manifest declares **only `storage`** — no `host_permissions` for `google-analytics.com` | same page |
| *"Using the Measurement Protocol means that some information, such as geolocation, won't be included"* | same page |
| *"If your Product handles any user data, then prior to installation, it must: Prominently disclose what user data will be collected and how it will be used. Obtain the user's affirmative and informed consent for such use."* — triggered by **any** user data, not only sensitive categories | CWS disclosure requirements |
| *"Extensions are required to disclose how they handle user data, even when data is processed or stored locally on a user's device and is not transmitted to external servers or third parties."* | CWS user-data FAQ |
| *"Extensions may collect analytics or performance data where it is reasonably necessary to maintain, secure, or measure the performance and reliability of the extension's disclosed functionality."* | CWS user-data FAQ |
| Limited Use applies to *"both the raw data obtained and the data aggregated, anonymized, de-identified, or derived from the raw data"*, and requires *"an affirmative statement that your use of the data complies with the Limited Use restrictions … disclosed on a website belonging to your extension"* | CWS Limited Use policy |
| **"When a new permission that triggers a warning is added, the extension will be disabled until the user accepts the new permission."** Adding or changing `host_permissions` match patterns triggers a warning | CWS/Chrome permission-warnings docs |
| *"Permissions must be requested from inside a user gesture, like a button's click handler"* — so `chrome.permissions.request` works from a popup button | `chrome.permissions` API reference |
| GA4 limits: **no limit on distinctly named events for web data streams**; ≤25 params/event; param values ≤100 chars; ≤25 events/request; body <130 kB; MP events may be backdated ≤72 h | GA4 MP "sending events" + GA4 limits |
| GA4 standard-property retention: 2 months default, 14 months maximum; *"the data retention setting does not affect standard aggregated reports"* | GA4 data-retention support page |

Two consequences drive the whole design:

- Because adding a required host permission **disables every existing install**,
  this feature ships with **zero manifest permission changes**.
- Because affirmative consent is required for *any* user data, it ships
  **opt-in, off by default**.

## 3. Decisions

| Decision | Choice |
| --- | --- |
| Sink | Google Analytics 4 via Measurement Protocol |
| Consent | Opt-in; off until the user accepts the one-time overlay. Written directly by the popup — never via the worker |
| Granularity | One GA4 event per feature use (debounced per page for DOM features) |
| Transport | The service worker is the **only** sender |
| Configuration signal | One `sa_config_snapshot` event per active day |

## 4. Architecture

```
feature code (content scripts, Console page, popup, DevTools panel)
    └─ track(name, params?)                     src/usage/track.js
         └─ chrome.runtime.sendMessage(...)
              └─ background service worker      src/background/index.js
                   └─ collect(msg)              src/usage/collect.js
                        ├─ consent gate  (usageConsent === true)
                        ├─ client id / session id
                        ├─ buildPayload()       src/usage/event.js  (pure)
                        └─ fetch POST /mp/collect
```

Four units, each with one job:

- **`src/usage/event.js` — pure, no DOM, no chrome APIs.**
  `buildPayload({ name, params, clientId, sessionId, version })` returns the MP
  request body. Validates the event name against GA4's documented rule
  (`/^[a-z][a-z0-9_]{0,39}$/`), rejects any param key absent from the allowlist,
  rejects any param value outside its declared enum/boolean domain, enforces
  ≤25 params and ≤100-char values, and asserts the serialized body is <130 kB.
  Throwing here is a programming error surfaced by tests, never at runtime to a
  user (`collect.js` catches and drops).
- **`src/usage/track.js` — the only API feature code sees.**
  `track(name, params?)` posts a `{ type: 'sa-usage', name, params }` message.
  Wrapped in `try/catch`, never awaited, always returns `undefined`. A telemetry
  fault cannot alter, delay or break a feature.
- **`src/popup/usageConsent.js` — the durable consent write.** `writeConsent(value)`
  writes `usageConsent` STRAIGHT to `chrome.storage.local`, and on revoke also
  removes `usageClientId`/`usageSnapshotDay` **and `usageSessionId`** in the same
  tick (leaving the session id behind would let a re-enable be joined to the
  previous client id, which the policy promises it cannot). **Measured
  2026-08-03:** routing this through the worker left the value ABSENT immediately
  after the click and present only ~50ms later (the worker must wake first), so
  closing the popup and reopening inside that window read "off" — the bug the
  owner reported. Nothing durable may depend on a message reaching the worker.
- **`src/usage/collect.js` — worker side.** Owns the consent gate, the session
  ID and the single `fetch`. The client ID is minted **lazily here** on the first
  event (not at consent time, for the same reason), which also heals a profile
  the old flow left with consent but no ID. Anything other than
  `usageConsent === true` (strict) results in a silent drop with no network call
  and no ID generation.
- **`src/popup/components/UsageCard.jsx`** — the consent card and, afterwards,
  the standing toggle.

`src/background/index.js` gains one listener, reusing its existing
`sender.id !== chrome.runtime.id` guard so only this extension's own contexts can
emit events.

## 5. Payload contract

**Sent, and nothing else:**

| Field | Value |
| --- | --- |
| `client_id` | Random UUID (`crypto.randomUUID()`), created **at consent time**, stored in `chrome.storage.local.usageClientId` |
| `events[0].name` | One name from the closed vocabulary in §6 |
| `ext_ver` | `chrome.runtime.getManifest().version_name` (the git short hash) |
| `session_id` | Random id held in `chrome.storage.session`, i.e. one per browser session |
| `engagement_time_msec` | `1` — the documented minimum so events register as engaged |
| snapshot booleans | Only on `sa_config_snapshot` (§7), as `0`/`1` |

**Never sent.** Not "avoided" — there is no field in the payload these could
travel in, and `event.js` rejects unknown keys and non-enum values:

- any URL, hostname, origin or organisation domain
- any user name, e-mail, user id or API token
- any queue, workspace, hook, schema, rule, label, engine, collection, dataset,
  annotation or document identifier or name
- any document, field, dataset, query, pipeline, prompt or chat content
- `page_location` / `page_referrer` — the body is hand-built, so GA4's automatic
  page fields never exist

Because `track()` accepts only a name plus optionally params drawn from a closed
enum vocabulary declared in `event.js`, a feature author has no channel through
which to attach free-form data even by accident. The allowlist is the second
layer; the API shape is the first.

**Honest nuance for `PRIVACY.md`:** the request is an HTTPS POST, so Google
receives the sender's IP at the network layer like any web request. Per Chrome's
own guide, geolocation is *not* included in the resulting Measurement Protocol
data. The policy will say exactly this rather than claim "no IP".

## 6. Event vocabulary (seed)

`sa_<surface>_<action>`, surfaces `rossum | netsuite | coupa | popup | console |
mdh | audit | inspector | galaxy | fabry | devtools | config`. GA4 imposes no cap
on distinct event names for web streams, so this list can grow per feature
without redesign. The full, current list is published in `PRIVACY.md`.

**Rossum content script** (each fires **once per page load**, via a module-level
flag, because these run off a MutationObserver and would otherwise fire per DOM
node):
`sa_rossum_schema_ids`, `sa_rossum_resource_ids`, `sa_rossum_expand_formulas`,
`sa_rossum_expand_reasoning`, `sa_rossum_scroll_lock`.
Action-triggered (fire on the real interaction, not on page load):
`sa_rossum_tooltip_close`, `sa_rossum_mdh_suggest_click`.
`track-viewed` is a silent always-on tracker with no user action — no event.

**Other sites:** `sa_netsuite_field_names`, `sa_coupa_field_names` (once per page
load).

**Popup:** `sa_popup_open`, `sa_popup_toggle_on`, `sa_popup_toggle_off` (both with
a `feature` param from the closed enum of the nine known toggle keys),
`sa_popup_experimental_unlock`, `sa_popup_unlock_annotation`.

**Console:** `sa_console_open`, plus one per app activation —
`sa_console_app_mdh`, `sa_console_app_audit`, `sa_console_app_inspector`,
`sa_console_app_galaxy`, `sa_console_app_fabry`.

**Within the Console apps** (the actions worth ranking for "where to invest"):
`sa_mdh_query_run`, `sa_mdh_export`, `sa_mdh_import`, `sa_mdh_stages_view`,
`sa_mdh_agent_query`, `sa_mdh_index_create`;
`sa_audit_search`, `sa_audit_fabry_ask`;
`sa_inspector_report`, `sa_inspector_followup`, `sa_inspector_revalidate`;
`sa_fabry_chat_send`, `sa_fabry_deep_verify`, `sa_fabry_architect_check`,
`sa_fabry_architect_implement`.
Galaxy's only meaningful action is opening it, already covered by
`sa_console_app_galaxy`.

**DevTools panel:** `sa_devtools_panel_open`, `sa_devtools_save`,
`sa_devtools_request_bar`, `sa_devtools_copy_curl`, `sa_devtools_preview`.

**Configuration:** `sa_config_snapshot` (§7).

## 7. Configuration snapshot

A usage count of zero is ambiguous: nobody enabled the feature, or everyone
enabled it and it proved useless. Those readings demand opposite actions (fix
discovery vs. delete), so enablement is measured too.

Once per active day (guarded by a `usageSnapshotDay` UTC date string,
`new Date().toISOString().slice(0, 10)`, in `chrome.storage.local`, checked when
the popup opens or any event is emitted),
the worker emits one `sa_config_snapshot` carrying `0`/`1` booleans for:
`schema_ids`, `resource_ids`, `expand_formulas`, `expand_reasoning`,
`scroll_lock`, `netsuite_fields`, `coupa_fields`, `experimental`. Eight params,
all booleans, all allowlisted — well inside the 25-param limit and inside the
payload contract.

## 8. Consent UX and copy

**Shown exactly once.** Two stored facts, deliberately not conflated:
`usageAsked` (has the overlay ever been *shown*?) and `usageConsent` (has it been
*answered*, and how?). The overlay appears automatically only when `usageAsked`
is absent, and writes `usageAsked: true` the moment it renders — so it never
returns on later popup opens. Closing it unanswered leaves counting **off** (the
safe default) and does not nag; the footer button is then the only way back in,
which is why that button renders as soon as `asked` is true, answered or not.
`overlayMode({ asked, reviewing })` is the pure decision (`'ask'` / `'review'` /
`null`) and is unit-tested directly.

**First showing** — a blocking **overlay over the whole popup** (`.usage-overlay`,
`position: fixed; inset: 0`, scrim + centred 340px card), rendered **outside** the
site-specific branch so it also reaches people whose current tab is not
Rossum/NetSuite/Coupa. Both buttons are answers and there is **no dismiss** on
this one showing. Fixed positioning escapes `#app`'s `overflow: hidden`, so the
card is never clipped by the 600px cap.

`App.jsx` withholds first paint until `storageValues`, `consent` **and** `asked`
have resolved — otherwise the overlay would flash for someone who has already
seen it.

Card body (the approved "two-column ledger"):

> ### Help decide what gets built
>
> Help us understand how the extension is used. Sharing usage data shows which
> features people actually use, so effort goes where it helps. It never includes
> your documents or customer data.
>
> | What's sent | What's NEVER sent |
> | --- | --- |
> | feature name | URLs or org domains |
> | extension version | names, emails, tokens |
> | a random ID, not tied to you | document or dataset content |
>
> **[ Share usage data ]  [ No thanks ]**
> Reversible any time. *See all events ›*

**Voice — superseded twice, current state:** an earlier instruction banned first
person; the owner then supplied this draft in "we" voice, so "we" stands and the
no-first-person test was removed. The copy says **extension**, never "plugin" —
the product calls itself an extension in `manifest.json`, the README and this
policy, and a test asserts the card never says "plugin". "user-sensitive data"
from the draft became "your documents or customer data": *sensitive data* has a
narrow legal meaning and would over-claim, since a random client ID **is**
collected. The ledger discloses the **random client id**, which earlier
drafts omitted —
"you said you aren't tracking me, but there's an ID" is better answered up front
than discovered in the policy. The link is deliberately **unnumbered** — "See all
events", not "all 41 events" — so it cannot disagree with the vocabulary as events
are added. The link is the **only** route to the full list: `PRIVACY.md` is
the single place it lives, and `tests/usage-boundary.test.js` proves that doc
complete in **both** directions (no name missing, no name the code can't send).
An in-popup expander was prototyped and rejected — it would have duplicated all
41 entries into the bundle for no gain.

**Afterwards** the overlay is replaced by a compact control in the **footer** —
`UsageFooterButton`, reading `● Usage data on` / `○ Usage data off`. The
footer is chosen deliberately: it is the only region rendered on **every** page,
supported or not, so the choice is reachable from anywhere. Clicking it does
**not** flip the setting — it **reopens the overlay**, so a change of mind happens
next to the explanation rather than as a silent state flip. The reopened overlay
adds a `Currently on.`/`Currently off.` line (so the two fixed button labels are
never ambiguous) and **is** dismissible — `×` button or scrim click, `onClose`
only, no write. Review mode is in-memory (`reviewingUsage`), never persisted: it
is a view mode, not a preference.

Because the ask is a fixed-position overlay and the persistent control is a
single footer item, Chrome's 600px popup height cap (commit `0ce76d3`) is not
affected either before or after answering.

## 9. Backward compatibility

- **No changes to required permissions** — nothing added to `permissions`,
  `host_permissions` or `content_scripts.matches`, the three fields documented as
  triggering a warning. This is what keeps all 108 existing installs from being
  disabled on update. The only manifest change this design can ever need is the
  §10 gate-5 fallback, `optional_host_permissions`, which the Chrome docs
  describe as *"granted by the user at runtime, instead of at install time"* —
  verifying that it causes no re-prompt for existing installs is part of that
  gate.
- **New storage keys only:** `usageConsent`, `usageClientId`, `usageSnapshotDay`
  in `chrome.storage.local`; the session id in `chrome.storage.session`. Absent
  ⇒ off. No existing key is read, repurposed or migrated; the orphaned keys
  documented in `CLAUDE.md` stay orphaned.
- **Non-consenting users get byte-identical behaviour.** `track()` is a no-op
  from their perspective (the worker drops the message before any ID exists), no
  feature path awaits it, and no network call is made.
- **Known artefact to document, not fix:** an extension update does not
  re-inject content scripts into already-open tabs, so Rossum/NetSuite/Coupa
  counts only begin in tabs reloaded after the update. Day-one numbers under-count.
- The popup's existing toggle mechanics (storage-backed vs. page-flag) are
  untouched; the new toggle is storage-backed and does **not** reload the tab.

## 10. Compliance and rollout gates

All must be true before the Release workflow runs:

1. **`PRIVACY.md` published at a public URL** (a repo file URL is acceptable).
   Required because the extension will handle user data — CWS requires a policy
   *"even when data is processed or stored locally."* Contents: what is stored
   locally and never transmitted; the exact fields sent when counting is on; the
   full event vocabulary; the never-sent list; the IP nuance from §5; Google
   Analytics 4 named as processor with the retention setting; how to turn it off
   and that doing so deletes the identifier; the required Limited Use
   affirmation; GitHub issues as the contact.
2. **Privacy-practices tab rewritten.** The listing currently declares no data
   collection — false the moment this ships. Check "user activity", give the
   justification the policy itself blesses (measuring the extension's own
   disclosed functionality), and make the Limited Use affirmation.
3. **Listing description gains the pre-install sentence** from §8, because the
   disclosure requirement is *"prior to installation."*
4. **GA4 property setup** (owner-owned): create the property and a Web data
   stream, generate the Measurement Protocol API secret, set event data retention
   to **14 months**, and verify in the property settings that Google signals and
   ads personalisation are off.
5. **Verification gate G1 — VERIFIED 2026-08-03: PASSED.** A throwaway probe in
   the service worker (`fetch` → `https://www.google-analytics.com/mp/collect`,
   result written to `chrome.storage.local`) was run from a freshly loaded
   `dist/` with the manifest's existing `host_permissions` only (localhost + the
   Rossum domains — `google-analytics.com` is not among them). Result:
   `ok status=204`. **No manifest change is required**, so no existing install
   can be disabled. The probe was reverted and `dist/` rebuilt clean.
   Had it failed, the fallback would have been
   `optional_host_permissions: ["https://www.google-analytics.com/*"]` requested
   from the consent button's click handler (a user gesture, as the API requires)
   — which still never disables an existing install.
6. **Expect a slower review** because privacy declarations changed. Rollback is
   one version back per `docs/chrome-web-store-release.md`.

The API secret ships inside the bundle and is therefore extractable, so events
can be forged by anyone who looks. Accepted: the data steers our own roadmap, it
is not a billing or security input. A proxy would only move the problem.

## 11. How the data gets read

- **Prune / prioritise:** GA4's standard Events report ranks event names directly
  — no dashboard modelling needed. This is precisely why per-use events were
  chosen over a daily aggregate.
- **Adoption trend:** standard aggregated reports are unaffected by the retention
  window, so the trend survives even at the 2-month default; retention is still
  set to 14 months for explorations.
- **Absolute adoption** comes free from the Chrome Web Store dashboard's user
  count. GA4 supplies the *ratios within the consenting cohort*; the store
  supplies the *denominator*.
- **Stated limitation:** consent is opt-in, so per-feature numbers describe the
  consenting cohort only and are a lower bound. Cohort composition is unknown by
  construction — we deliberately collect nothing that would characterise it.

## 12. Testing

- **`event.js` (pure, no mocks):** name regex accepts/rejects; unknown param key
  rejected; non-enum param value rejected; >25 params rejected; >100-char value
  rejected; body <130 kB asserted; snapshot payload shape.
- **Consent gate:** `track()` with `usageConsent` absent/`false`/`'true'` ⇒ zero
  `fetch` calls and no `usageClientId` written; with `true` ⇒ exactly one POST.
- **Revocation:** toggling off deletes `usageClientId`.
- **Debounce:** feeding 300 DOM nodes through a Rossum feature handler produces
  exactly one event.
- **Snapshot cadence:** two emissions on the same date ⇒ one snapshot event.
- **Boundary test** in the style of `tests/fabry-write-boundary.test.js`: only
  `src/usage/**` may reference `google-analytics.com`, asserted against the
  built bundles in `dist/`.
- **Live smoke:** send through `/debug/mp/collect` first (it validates and
  reports errors), then confirm in GA4 Realtime before trusting the real
  endpoint.
- Vitest convention per `CLAUDE.md`: tests are `.test.js` using
  `h(Component, null)`, never raw JSX.

## 13. Out of scope

Funnel/drop-off analysis, per-user reporting, error/crash reporting, performance
timing, any cohort or role tag (a self-declared "internal / partner / customer"
tag was considered and dropped as unnecessary for the three questions in §1), and
any second distribution channel.
