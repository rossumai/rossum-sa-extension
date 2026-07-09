# Annotate-for-me: Experimental unlock (5× version click) — Design

Owner-approved 2026-07-08. Goal: when the extension ships publicly, "Annotate for
me" must not be obviously available — hidden behind a popup easter-egg, not a
visible toggle.

## Mechanism

- New `chrome.storage.local` key **`experimentalUnlocked`** (boolean, absent by
  default).
- **Popup:** clicking the version hash in the footer **5 times in quick
  succession** (counter resets after 2s without a click) flips
  `experimentalUnlocked`. A brief inline notice confirms: "Experimental features
  unlocked" / "Experimental features hidden".
- When unlocked, an **Experimental** toggle-group appears in the Rossum card
  containing the "Annotate for me" checkbox (moved out of the public Behavior
  group — locked popups show no trace of the feature). Re-locking hides the
  group but preserves the checkbox value.
- **Content script double-gate:** `experimentalUnlocked` joins `SETTINGS_KEYS`;
  the feature injects only when `annotateForMeEnabled && experimentalUnlocked`.
  Re-locking therefore disables the feature on next tab load, not just its UI.
- Flipping the unlock reloads the active tab only when `annotateForMeEnabled`
  is on (otherwise nothing on the page changes).

## Non-goals / accepted risk

- Not cryptographic secrecy: the key is findable in the public source. The
  backstop is that the Fabry Agent API host is unreachable outside Rossum.
- No org allowlist, no network probe in the popup.

## Backward compatibility

The feature has never shipped (all work uncommitted), so no user has these
keys. `annotateForMeEnabled` set alone → feature stays off (safe default).

## Files

- `src/popup/experimental.js` — pure `createUnlockCounter({threshold, windowMs, now})`
- `src/popup/components/App.jsx` — version-click wiring, Experimental group
- `src/rossum/features/annotate-for-me.js` — pure `isAnnotateEnabled(settings)`
- `src/rossum/index.js` — double-gate via `isAnnotateEnabled`
- Tests: counter behavior, gate behavior.
