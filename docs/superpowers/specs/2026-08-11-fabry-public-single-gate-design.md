# Make Fabry public; consolidate onto one hidden-features gate

**Date:** 2026-08-11
**Status:** design approved, implementation pending

## Goal

Mr. Fabry (`src/fabry/`) becomes visible to every user — no gesture, no unlock. The
Academy (`src/academy/`) stays hidden. The two gate keys collapse into one,
`experimentalUnlocked`, which from now on means "the extension's hidden features"
rather than "the Fabry app".

## Verified facts this design rests on

Every claim below was checked against the tree at `9730a29`, not assumed.

| Fact | Evidence |
| --- | --- |
| `experimentalUnlocked` gates exactly one thing today: the Fabry rail item | `src/console/components/Rail.jsx:56` (`gatedBy: 'fabry'`), `src/console/boot.js:14-29`, `src/console/index.jsx:121-138` |
| There is no popup "Experimental section" any more — only a stale comment | `src/popup/components/App.jsx:23-25` |
| The read-only Fabry surfaces are ALREADY public — MDH AgentBox, Inspector synthesis, Audit band gate on `probeAgent()` health only, never on the key | `src/mdh/index.jsx:103-121`, `src/inspector/index.jsx:99`, `src/mdh/components/PipelineEditor.jsx:150` |
| So ungating the app adds no new agent transport or data-egress posture for reads | follows from the row above |
| What the gate uniquely holds back is the Architect **implement loop**: autonomous, write-enabled (`mcp_mode: 'read-write'`), `implementAllowed` defaults `true`, per-run Arm dialog is the only remaining gate | `src/fabry/store.js:43`, `src/fabry/architect/components/ArmDialog.jsx`, CLAUDE.md §Architect implement loop (G1: no server-side write-lock) |
| `trainingUnlocked` was introduced in `9730a29` — HEAD, five commits past the last store release (`7348ae7` = version 0.330) | `git log -S"trainingUnlocked" --reverse -- src/`, `git rev-list --count 7348ae7` = 330 |
| That same commit already writes BOTH keys in one `chrome.storage.local.set` | `src/popup/components/App.jsx:226` |
| The content script reads the gate only through `gate.js`, never the raw key | `src/rossum/features/training-quest.js:16,209,215` |
| The popup has no Academy/training UI — only the dual-write import | `src/popup/components/App.jsx:13,226` |
| PRIVACY.md documents the config snapshot generically ("one 0/1 flag per feature toggle"), with no per-param list to maintain | `PRIVACY.md:143` |

### Measured layout facts (headless, against the live `console.css`)

Rail is 76px wide; a rail item is 60px; item height 71px; rail has 577px of vertical
room at six items. Existing `beta` pill: 30.2px wide, spanning 36.2px from the item's
right edge.

| Badge text | top-right pill | stacked chip under label |
| --- | --- | --- |
| `experimental` @7.5px caps | 74.5px — overflows the **rail** by 4.5px | 72.5px — overflows the item |
| `experimental` @7px lowercase | — | 54.9px (fits, but changes the type style) |
| `unstable` @7.5px caps | 53.7px / 59.7px span — 0.3px clearance, too tight | 51.7px (fits) |
| `unstable` @7px caps | 51.1px / 57.1px span — 2.9px clearance | — |
| `exp` @7.5px caps | **25.1px / 31.1px span** — narrower than `beta`, no type change | — |

## Design

### 1. One gate

`experimentalUnlocked` is the extension's single hidden-features switch, flipped by
5 quick clicks on the popup version hash exactly as today. Fabry loses its gate
entirely. The Academy moves onto `experimentalUnlocked`. `trainingUnlocked` is
retired.

The key **name** is deliberately unchanged. Renaming would buy nothing and cost a
storage migration, a GA4 discontinuity on the `experimental` snapshot flag, and an
edit to the closed usage vocabulary. `experimentalUnlocked` is internal; the
user-facing word is set by the popup copy and the rail badge (§3).

### 2. Rail

- The `fabry` row drops `gatedBy` and renders unconditionally. Rail default goes
  4 items → 5.
- The `academy` row is gated on `experimentalUnlocked`. With one gate left, the
  two-entry `gates` map in `Rail.jsx` collapses to a single boolean.
- Ordering is unchanged: Data, Audit, Inspector, Fabry, Galaxy, Academy.
- Fabry keeps its `beta` badge — it is beta, and Inspector sets the precedent for a
  publicly-visible beta app.

### 3. Badge and copy: "EXP"

The Academy's badge changes from `beta` to `EXP`, keeping the current top-right pill
shape, position **and type** (7.5px uppercase). At 25.1px it is narrower than the
existing `beta` pill (30.2px), so it needs no font-size concession and no geometry
change — it is the only candidate that fits the badge exactly as built.

The word is the abbreviation of the gate it belongs to: one vocabulary from the storage
key `experimentalUnlocked` through the popup notice to the badge. Because `EXP` is an
abbreviation, the rail item's `title` carries the full word — `Onboarding training —
experimental` — so the hover tooltip spells out what the badge means.

Implementation: a sibling class beside `.app-rail-beta` sharing the pill geometry and
overriding only the tint — **`--info-bg`/`--info-fg`** (blue) against `beta`'s
`--warning-*` (amber), so the two are separable at a glance. Both `--info-*` values are
defined in the light and dark blocks (`console.css:29-31, 81-83`). Not `--accent-bg`/
`--accent-fg`: those are **never defined** — only `--accent` and `--accent-hover` exist —
so a badge tinted with them would render transparent. (`console.css:1271` already uses
the undefined `var(--accent-bg)` bare; out of scope here, worth noting separately.)
Note `tests/console-rail.test.js:127` already
asserts against a `.app-rail-exp` class name from an earlier design; this change gives
that name a real referent, and that assertion moves from the Fabry row to the Academy row.

The popup unlock notice changes from `Experimental features & training unlocked` /
`… hidden` to **`Experimental features unlocked`** / **`Experimental features hidden`** —
dropping "& training", which described the two-key era.

`PRIVACY.md:89`'s description of `sa_popup_experimental_unlock` becomes "you unlocked
the extension's experimental features" — same vocabulary again; there is no
"experimental section" left to refer to. The event name itself is unchanged, preserving
the GA4 series.

### 4. Change surface

| File | Change |
| --- | --- |
| `src/console/components/Rail.jsx` | `fabry` row loses `gatedBy`; `gates` map → one boolean gating `academy`; academy badge → `EXP` via the new class; academy `title` gains "— experimental" |
| `src/console/console.css` | `.app-rail-exp` beside `.app-rail-beta`, sharing the pill geometry, accent tint |
| `src/console/boot.js` | `pickInitialApp({…, fabryUnlocked, academyUnlocked})` → `({…, unlocked = false})`, academy-only; `appAfterGateChange(app, unlocked)` loses its fabry clause. Default stays **locked**, so an omitted flag still fails safe |
| `src/console/store.js` | `trainingUnlocked` signal removed |
| `src/console/index.jsx` | one key read, one `onChanged` arm, one gate effect |
| `src/training/storage.js` | `UNLOCK_KEY = 'experimentalUnlocked'` — one line moves the content-script quest card, the only consumer of `gate.js`; the Academy's visibility is moved separately, by the Console rail and shell reading the same key |
| `src/training/gate.js` | comment rewritten; its stated rationale is now void (below) |
| `src/popup/components/App.jsx` | `onVersionClick` writes one key; `UNLOCK_KEY` import dropped; notice copy; comment rewritten |
| `PRIVACY.md` | line 89 description |

`gate.js`'s current comment says a trainee "must not acquire an autonomous write
capability against their org as a side effect" of unlocking training. That protection
no longer exists to preserve: Fabry, implement loop included, is public for every user,
so a trainee has it whether or not they ever unlock anything. The comment must say what
is true now rather than keep a rationale the code no longer delivers.

### 5. Backward compatibility

No migration, and that is provable rather than assumed:

- `trainingUnlocked` exists only in `9730a29`, five commits past the released 0.330,
  so it has never shipped to the Chrome Web Store.
- That commit already writes both keys in a single `set`, so no profile anywhere can
  hold `trainingUnlocked: true` without `experimentalUnlocked: true`. The
  separate-gesture variant described in CLAUDE.md was removed before the commit landed
  and never existed in a committed build.
- Therefore every install that has unlocked keeps the Academy, and every install gains
  Fabry. `trainingProgress` is untouched — no trainee loses progress or a receipt.
- `trainingUnlocked` is documented as an orphaned key, matching how this repo already
  treats `fabryDeepVerifyEnabled`, `annotateForMeEnabled`, and `inspectorRecents`.
- A per-tab `consoleActiveApp: 'fabry'` now resolves with no gate — strictly more
  permissive, so no stored navigation state breaks.

### 6. Usage / GA4

Untouched. `SNAPSHOT_KEYS.experimental → experimentalUnlocked` keeps reporting the same
bit from the same key, so the series stays continuous and no new custom dimension needs
registering. `sa_console_app_fabry` will start arriving from non-dogfooders — that is
the intended effect of the change, not a regression.

## Accepted risk (owner decision, 2026-08-11)

Making Fabry public makes the Architect implement loop public: an autonomous,
write-enabled agent run against a live customer org, with no server-side write-lock,
behind only the per-run Arm dialog. This was raised with the owner, who chose "fully
public, implement included". Recorded here so the decision is legible later, not to
reopen it. The client-side write boundary is unchanged and still enforced by
`tests/fabry-write-boundary.test.js`: only the transport and `src/fabry/architect/**`
may reference `read-write`.

## Tests

| File | Change |
| --- | --- |
| `tests/console-rail.test.js` | Fabry present regardless of gate (default count 4 → 5); academy gate driven by `experimentalUnlocked`; the paired "unlocking training reveals Academy and NOT Fabry" / "…and NOT Academy" tests collapse into one single-gate assertion; the `.app-rail-exp` assertion at line 127 moves from the Fabry row to the Academy row and flips to expecting the badge |
| `tests/console-boot.test.js` | `pickInitialApp`/`appAfterGateChange` signature collapse; fabry is never gated |
| `tests/console-academy-wiring.test.js` | same signature collapse; drops its "keeps the existing fabry behaviour untouched" case |
| `tests/popup-training-gate.test.js` | one-key write; notice copy |
| `tests/training-content-wiring.test.js` | string assertions naming `trainingUnlocked` |

New coverage worth adding: the gate default stays locked when the flag is omitted
(`pickInitialApp({persistedApp: 'academy'})` → `'mdh'`), so a future caller that forgets
the flag hides the Academy rather than revealing it.

Untouched: `tests/fabry-write-boundary.test.js`, `tests/training-key-boundary.test.js`
(the receipt signing-key boundary is unrelated to the unlock gate), and every
`tests/fabry-*.test.js` behaviour test.

## Docs

CLAUDE.md needs edits in five places: the Console app list (line 28), the training gate
paragraph (208-224, whose entire rationale for two keys is now void), the Fabry section
opener (367), the Architect gate notes (489, 498), and the storage-key list (685, 695 —
`trainingUnlocked` moves to the orphaned list).

## Out of scope

- Renaming the `experimentalUnlocked` storage key, the `sa_popup_experimental_unlock`
  event, or the `experimental` snapshot param.
- Any change to what the implement loop does, its bounds, or its Arm dialog.
- Any change to Fabry's rail position or its `beta` badge.
- Restoring a popup entry point for the Academy (removed 2026-08-11 by owner decision).
