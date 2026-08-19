# Usage tracking, simplified — design

Date: 2026-08-19
Supersedes parts of: `docs/superpowers/specs/2026-08-03-feature-usage-measurement-design.md`
(that document stays as the record of the original build; this one records what
changed and why).

## 1. Why

The owner's requirement, stated verbatim: *"I only care about which features are
being used and how often (whether someone is opening the apps in the console,
whether some features are being used and so on)."*

Measured against that, the shipped subsystem carries two things that do not serve
it:

- a **daily configuration snapshot** that reports which toggles are *enabled* —
  a different question from which features are *used*; and
- a **parameter allowlist** whose entire remaining purpose is one `feature`
  dimension on the popup's toggle events.

Asked where the pain was, the owner selected **"too many concepts"** and
**"GA4 is awkward to read"**, and explicitly did *not* select the per-feature
maintenance chore or the consent surface. So the event names and the consent flow
are deliberately left alone; the concepts around them are what shrink.

Asked how the numbers should be read, the owner chose: **shape the data so GA4's
built-in Reports → Engagement → Events report is the whole answer.** Every design
decision below follows from that. In particular it rules out collapsing the
vocabulary into a single `sa_use` event with a `feature` dimension — see §9.

## 2. Facts this design rests on

Everything here was verified during design, not assumed.

**Verified in this repository (2026-08-19):**

- The vocabulary is currently exact in both directions: all 47 names have a real
  emit site, and no `sa_*` literal in `src/` is missing from the list.
- `{ feature: key }` at `src/popup/components/App.jsx:203` and `:234` is the
  **only** caller-supplied parameter anywhere in the codebase. Nothing else
  passes a second argument to `track()`.
  (Four grep hits in `IndexPanel.jsx` / `SearchIndexPanel.jsx` are a *different*
  local `track(opId, …)` from `src/mdh/hooks/useOperationStatus.js` — unrelated to
  usage reporting. Do not "fix" them.)
- `src/usage/event.js` is imported by **nothing** in `src/` — only by
  `collect.js` (worker-side) and three test files. 31 feature files import
  `track.js`, which imports nothing at all. The comment in `event.js` claiming it
  "stays importable from ANY surface without dragging the analytics host into
  that surface's bundle" therefore protects a hypothetical importer, not a real
  one. The comment is corrected; the file stays split, because the pure /
  impure-glue division is the house pattern and merging would put the vocabulary
  in a module that names the analytics host.

**Verified against Google's documentation (2026-08-19):**

- **`session_id` and `engagement_time_msec` must both stay.** Google's guidance:
  *"In order for user activity to display in standard reports like Realtime,
  engagement_time_msec and session_id must be supplied as part of the params for
  an event."* Deleting either stops the property counting users. Neither is a
  candidate for removal, however much they look like envelope noise.
- The GA4 **Data API v1beta `runReport`** does support `eventName` × `eventCount`
  (plus `activeUsers` / `totalUsers`), via the `analytics.readonly` scope, with a
  200,000 core-tokens-per-property-per-day quota on a standard property. This was
  verified as a live option for reading the data out of GA4 with a script; the
  owner chose the built-in report instead, so **nothing in this design depends on
  it**. Recorded here so the option does not have to be re-verified later.

**Carried from `reference_ga4_property_facts` (owner-verified 2026-08-04):**

- The built-in Events report *is* the feature ranking, because every event in the
  property is one of the `sa_*` names. Retention affects explorations and funnel
  reports, **not** aggregated standard reports.
- Active Users works for this property (every event carries
  `engagement_time_msec`), which is what supplies the install denominator once
  the daily snapshot is gone.
- A registered custom dimension or metric needs 24–48h to become reportable and
  Google documents no backfill. This is a cost the built-in report avoids
  entirely.

## 3. What is removed

Three event names, and nothing else is renamed:

| Removed | Why |
| --- | --- |
| `sa_config_snapshot` | Reports enabled, not used. |
| `sa_popup_toggle_on` | Configuration, not use. Its `feature` param is the last caller-supplied parameter in the codebase. |
| `sa_popup_toggle_off` | As above. |

47 → **44 names**. Every surviving name is byte-identical to today, which is what
keeps the GA4 Events report continuous across the release: existing rows keep
growing rather than being orphaned beside new ones.

## 4. Module design

### 4.1 `src/usage/event.js` (146 → 99 lines; 106 → 54 executable)

```js
buildPayload({ name, clientId, sessionId, version })
```

No `params` argument. Deleted: `TOGGLE_FEATURES`, `SNAPSHOT_KEYS`,
`buildSnapshotParams`, `PARAM_SPEC`, the `hasOwnProperty` prototype-pollution
guard, the 25-parameter cap and the 130KB payload cap.

The two caps go because they become **provably unreachable**, not because the
constraint stopped mattering: the body is now a 36-character uuid, one event name
of at most 40 characters, and exactly three fixed fields — roughly 250 bytes,
always. A comment at the deletion site records that proof, so a future reader does
not restore the check by reflex.

`NAME_RE` moves from a runtime branch to a **test assertion over `EVENT_NAMES`**.
A closed literal list can be checked once at build time; validating each send
against a regex the list itself already satisfies is work performed at the wrong
moment.

Surviving runtime validation, in full: the name is in `EVENT_NAMES`, and
`clientId` is a non-empty string of at most 100 characters. `ext_ver` is included
only when the manifest read yields a string, so a failed read omits the field
rather than sending an empty one.

The resulting `params` object is the same three fields for every event:
`{ ext_ver, session_id, engagement_time_msec: 1 }`.

### 4.2 `src/usage/collect.js` (112 → 88 lines; 71 → 53 executable)

Removed: both snapshot imports, the entire daily-snapshot block, and
`usageSnapshotDay` from `READ_KEYS` — now `['usageConsent', 'usageClientId']`.
The "explicit key list, never `getLocal(null)`" rationale is unchanged and gets
stronger with fewer keys.

Unchanged: the consent gate, the lazy client-id mint, the session id, and the
swallow-everything contract. `collect()` still returns a count; it is now only
ever 0 or 1.

**The serialized `queue` stays, and this needs saying because it now looks
deletable.** With the snapshot gone, the lazy client-id mint is the only
read-modify-write left — but it is still a check-then-act across an await, so a
burst of events on a fresh profile would otherwise mint several ids and send
events under different identifiers.

### 4.3 `src/usage/track.js`

`track(name)` and `trackOnce(name)` become single-argument functions. The message
is always `{ type: 'sa-usage', name }`. The cached-consent short-circuit is
untouched.

### 4.4 Call sites

**Two deletions, both in `src/popup/components/App.jsx`** — the `track(…)` line
in `setStorageToggle` (line 203) and in `setMessageToggle` (line 234). The other
25 files that import `track.js` are untouched.

## 5. Backward compatibility

- **Storage meanings are preserved.** `usageConsent`, `usageAsked`,
  `usageClientId` and `usageSessionId` keep their exact semantics: nobody is
  re-asked, nobody is silently re-consented, and the identifier carries over so
  Active Users does not spike at the release boundary.
- **`usageSnapshotDay` becomes orphaned** — not migrated, not cleaned up. That
  includes dropping it from `writeConsent`'s remove-list, so a profile that opts
  out after this release keeps a stale key nothing reads. This follows the repo's
  existing convention for retired keys (CLAUDE.md documents several) rather than
  carrying a live reference to a dead one.
- **No manifest change.** Nothing is added to `permissions` or
  `host_permissions`, so no existing install is disabled pending re-approval.
- **An orphaned content script cannot poison the new worker.** After an upgrade
  either `chrome.runtime` is invalidated and `track` swallows the throw, or the
  message arrives and is dropped at `EVENT_NAMES.includes('sa_popup_toggle_on')
  === false`. Silent and correct in both directions.
- **GA4 history is preserved but frozen for the three removed names.** They can
  be neither renamed nor backfilled, so those rows remain and simply stop
  growing. The 8 custom metrics and the `feature` dimension stop receiving data;
  they may stay registered harmlessly (caps are 50 and 50) or be archived by the
  owner.

## 6. Privacy

`PRIVACY.md` loses three table rows, the whole **Configuration** section, and the
bullet describing "one 0/1 flag per feature toggle". The remaining "each usage
event contains exactly" list then becomes literally exhaustive, so the claim
strengthens to: **no field in the payload varies with what you did, except the
event name.**

The Chrome Web Store listing's policy URL is unchanged, and the extension now
discloses and sends strictly less — which cannot invalidate an existing store
declaration.

`tests/usage-boundary.test.js` already asserts the doc and `EVENT_NAMES` agree in
both directions, including an exact count, so the test fails until the document is
edited. That forcing function is kept, and **two guards are added to it**, because
deleting the allowlist opens a gap the name-pairing assertions cannot see:

1. **The payload shape is pinned to the document's promise.** For every name in
   the vocabulary, `buildPayload` must emit exactly
   `{ ext_ver, session_id, engagement_time_msec }` and nothing else. Until now
   that sentence in `PRIVACY.md` was self-evidently true because `PARAM_SPEC` was
   a visible allowlist a reviewer would notice; with it gone, a future fourth
   field would silently make a published privacy policy false and no test would
   object. The guard is deliberately placed in the `PRIVACY.md` describe block
   rather than in `usage-event.test.js`, so it reads as a claim about the
   document.
2. **Every event name must appear in backticks**, replacing a looser
   `text.includes(name)` that would accept a name buried in prose or matched as a
   substring of a longer name.

Both are guards over already-correct behaviour, so neither has a red phase. The
plan therefore requires proving each can fail — by adding a fourth payload field
and a bogus event name, watching the failures, and reverting. This repo already
treats an unfalsifiable guard as a defect worth its own assertion (see
`tests/usage-console-events.test.js`, "actually skips the vocabulary file —
otherwise these tests are tautologies").

The human-readable half of the same forcing function is the sentence in
`event.js`'s header telling a future author that adding an event means editing
`PRIVACY.md` too. It must survive the comment rewrite in §4.1; it is not
redundant with the test, because it is what a person reads before the test ever
runs.

## 7. Tests

| File | Change |
| --- | --- |
| `tests/usage-event.test.js` | Drop the allowlist and snapshot suites; add a name-format assertion over `EVENT_NAMES` (replacing the runtime `NAME_RE`) and one asserting the payload is exactly the fixed envelope. |
| `tests/usage-collect.test.js` | Drop the three snapshot tests. Keep the consent gate, lazy mint, serialization and swallow tests. |
| `tests/usage-track.test.js` | Drop "includes params only when given". |
| `tests/popup-usage-consent.test.js` | Drop the `usageSnapshotDay` removal assertion. |
| `tests/usage-boundary.test.js` | **Gains two guards** (see below). Its existing name-pairing assertions derive from `EVENT_NAMES` and need no change. |
| `tests/usage-console-events.test.js` | No edit — derives from `EVENT_NAMES`, and will catch either `App.jsx` deletion if one is missed. |
| `tests/popup-usage-card.test.js` | No edit — the consent UI is out of scope. |

### 7.1 Documentation

- **`CLAUDE.md`** — the "Usage data (opt-in)" section (from line 1305) describes
  the param allowlist, `SNAPSHOT_KEYS` and the snapshot piggyback; the storage-key
  list (line 1301) documents `usageSnapshotDay` as live. Both are rewritten, and
  `usageSnapshotDay` joins the file's existing roll of orphaned keys.
- **`README.md`** — no edit. Its usage section already says the extension "sends
  the feature's name and the extension version", which this change makes more
  literally true rather than less.
- The 2026-08-03 spec and plan under `docs/superpowers/` are **left untouched** as
  the historical record of the original build. This document is the record of the
  change.

## 8. What is lost, stated plainly

- Telling **"enabled but never used"** apart from **"never discovered"** is gone
  for all seven storage toggles.
- **`devFeaturesEnabled` and `devDebugEnabled` go completely dark.** They are
  page flags written into the page's own localStorage; the extension cannot
  observe their use, so the toggle event was their only signal. Accepted
  knowingly.
- Attributing a **feature's use to a specific toggle being flipped** in the same
  session is no longer possible. `ext_ver` is kept, so attributing a change to a
  *release* still is.

## 9. Rejected alternative: one event name plus a `feature` dimension

Collapsing all 44 names into `sa_use` with `feature: 'mdh_export'` would reduce
the vocabulary to a few lines. It was rejected on three grounds:

1. It **re-introduces a parameter allowlist** — now with 44 values — immediately
   after deleting one. The concept count does not fall; it moves.
2. It **breaks the chosen reading strategy.** The built-in Events report would
   show a single row, pushing the ranking into a custom-dimension exploration
   that needs registration, a 24–48h wait, and which is subject to the 14-month
   retention that standard reports are not.
3. It **orphans all existing history**, since GA4 offers neither rename nor
   backfill.

## 10. Follow-up for the owner (GA4 UI, not code)

Optional and safe to defer: archive the 8 custom metrics (`schema_ids`,
`resource_ids`, `expand_formulas`, `expand_reasoning`, `scroll_lock`,
`netsuite_fields`, `coupa_fields`, `experimental`) and the `feature` custom
dimension. `ext_ver` stays live.

## 11. Net effect

Measured after implementation, replacing the estimates this section originally
carried. The line-count estimate was **wrong** and is corrected here rather than
quietly dropped: it predicted ≈330 total lines against an actual 443.

| | Before | After | |
| --- | --- | --- | --- |
| Event names | 47 | 44 | |
| Caller-supplied params | 1 | **0** | the headline: no field exists for feature data to travel in |
| Storage keys | 5 | 4 | |
| GA4 custom definitions in play | 10 | 1 | only `ext_ver` still receives data |
| **Executable** lines, four changed modules | 224 | **152** | −32% |
| — of which `event.js` | 106 | **54** | −49% |
| Total lines incl. comments, six files | 515 | 443 | −14% |

The gap between the executable-line cut (−32%) and the total-line cut (−14%) is
deliberate and should not be optimised away: the deletions took explanatory
comments with them, and three new ones were added where the code no longer
explains itself — that the serialization queue is still required by the lazy
client-id mint and must not be deleted as dead weight, that the removed GA4 caps
are unreachable by construction rather than merely unimportant, and that the
leak guard is now structural rather than validated. In this repo a comment
recording *why* something must not be re-added is load-bearing.
