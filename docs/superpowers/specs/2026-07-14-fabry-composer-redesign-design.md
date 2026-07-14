# Fabry chat composer redesign (Claude-style, in-box controls) — design

**Date:** 2026-07-14
**Status:** design approved (Design 1 of the 3 browser mockups)

## Goal

Make the Mr. Fabry chat composer taller and Claude-shaped: one rounded box with
**all controls moved inside** it (attach, persona, deep-verify, send/stop), replacing
today's stacked layout (persona/deep-verify row above the input). Keep Fabry blue
(not Claude terracotta). Fabry has no voice, so no mic/waveform.

## Layout (Design 1 — icon-forward)

One rounded box (`.fabry-composer-box`), top-to-bottom:
1. **sendError** line (when set) — above the box, unchanged.
2. **Attachment thumbnails** row — *inside* the box at the top, when images attached.
3. **Textarea** — taller min-height (~46px ≈ 2 lines), auto-grows to 180px (unchanged max).
4. **Bottom bar**:
   - **Left:** `+` attach-image icon button (was 📎). While **streaming**, the rainbow
     gerund loader sits inline just right of `+`.
   - **Right cluster:** persona chip (`Cautious ▾`, **new-chat only**) → ✦ deep-verify
     icon toggle (when `deepVerifyAllowed`) → send/stop.
5. **Notice** — below the box, unchanged.

`/`-command menu still floats above the box (`CommandMenu`, unchanged).

## Controls

- **Attach** (`+`): icon button; opens the hidden file input. Same accept/drop/paste
  rules (png/jpeg/gif/webp, ≤4 images, ≤5MB) and the concurrent-safe cap logic.
- **Persona chip → dropdown** (new behavior): replaces the segmented control. The chip
  shows the current persona label + ▾. Click opens a small popup listing both personas
  (`Cautious` / `Autonomous`) with their hints and a ✓ on the current one; picking sets
  `store.personaChoice` and closes. Closes on outside-click / Escape / select. Shown only
  when `isNewChat` (persona is locked mid-chat), matching today's gating.
- **Deep verify** (✦ icon toggle): bare static `FabryMark` icon; dim when off,
  accent-filled (`--accent` + accent-bg) when on. Shown when `deepVerifyAllowed`. The
  explanation shows in a **rich hover popup** via the shared `<Tip>` component (promoted
  from MDH to `src/ui/Tip.jsx` + `Tip.module.css`, and enhanced to auto-flip ABOVE the
  trigger since the composer is bottom-anchored) — replaces the native `title`; the button
  keeps an `aria-label` for a11y.
- **Send** (↑ arrow, accent rounded square): disabled/grey when the draft is empty;
  accent when there's text. **Streaming → Stop** (■ square button) in the same slot.

## Preserved behavior (no regressions)

Enter submits / Shift+Enter newline (reads live `e.target.value`); paste & drop image
attach; auto-grow textarea; `personaChoice` applies to the next new chat; `deepMode`
toggle; draft+images restored on send failure without clobbering a newer draft;
streaming shows "Prepare your next message…" placeholder + Stop.

## CSS

The composer is a **Fabry-app component** (`src/fabry/`), not a `/ui/` shared one, so its
styles stay in `console.css` for this pass (consistent with the other `.fabry-*` chat
rules). Rework the existing `.fabry-composer` / `.fabry-persona` / `.fabry-field` /
`.fabry-send` / `.fabry-stop` / `.fabry-deep-toggle` rules into the in-box layout; add
`.fabry-composer-box`, the bottom `.fabry-bar`, `.fabry-persona-chip` + `.fabry-persona-menu`,
icon-button, and send/stop-square rules. (A later pass can modularize it — out of scope here.)

## Testing

Update `tests/fabry-composer.test.js`: box renders textarea + bottom bar; `+` present;
persona chip opens the dropdown and selecting sets `personaChoice` (new chat only, hidden
mid-chat); deep-verify toggle flips `deepMode`; send disabled when empty, enabled with text;
streaming shows Stop (calls `stopStreaming`) + inline gerund; `/`-menu still appears. Keep
the existing send/stop/gerund assertions (retargeted to the new markup). Full suite green;
rebuild `dist/`.

## Non-goals

No voice/mic. No CSS-module migration of the composer. No change to send/stream logic in
`chat.js`. No dark-mode-specific work beyond the existing token usage.
