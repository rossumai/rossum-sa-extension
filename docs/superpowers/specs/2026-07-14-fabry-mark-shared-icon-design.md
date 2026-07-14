# Shared animated Fabry mark (`<FabryMark>`) — design

**Date:** 2026-07-14
**Status:** approved (decisions confirmed in brainstorming)

## Goal

Replace the three inconsistent "Mr. Fabry" marks with **one** shared component in
the `src/ui/` design system, and give it a slow, always-on color animation that
stays in a blue/purple band. Reduce visual drift; single source of truth for the
Fabry identity mark across every in-app surface.

## Current state (verified)

Three distinct marks exist today, none sharing code:

1. **SVG four-point star** — `FABRY_ICON` in `src/console/components/Rail.jsx`
   (`viewBox 0 0 24 24`, path `M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z`),
   rendered **outline** (`fill:none; stroke:currentColor`). Only in the Console app-rail.
2. **`✦` (U+2726) glyph** — the brand mark in **6 spots**: `Sidebar` (`fabry-sidebar-mark`),
   `ChatHeader` (`fabry-hd-mark`), `Thread` greeting (`fabry-greeting-mark`), Audit
   `FabryPanel` (`audit-fabry-mark`), `Composer` "Deep verify" (inline), and the shared
   `FabryInput` spark (`agent-spark` — purple→pink gradient text-fill, twinkles only while
   loading).
3. **`✨` (U+2728) sparkles** — Inspector `DiagnosisPanel` header, plus two **Rossum
   content-script** buttons (`annotate-for-me`, `dataset-mgmt-suggest`).

Base colors: `--accent` is **blue** (`#4270db` light / `#5b8af0` dark); the spark gradient
is purple→pink (`#8b5cf6`→`#ec4899`); Diagnosis identity is purple (`--diag-fg #5b21b6`).

`prefers-reduced-motion` already disables all existing Fabry animations.

## Scope (confirmed)

**In scope — unify into `<FabryMark>`:** all 6 `✦` spots, the Inspector `✨`
(→ four-point star), and the rail SVG. Rail renders **static** (no animation) and
**filled** (adopts the same filled star; deliberate refresh from today's outline).

**Out of scope:** the two content-script `✨` buttons — they are plain DOM in the
*separate Rossum content-script bundle* with `rossum-sa-extension-*` styles and cannot
import a Preact component. Left untouched (still `✨`).

Also out of this spec: the broader "find more opportunities to unify" pass — delivered
*after* this lands as a grounded findings list for the owner to pick from, not a silent
refactor.

## CSS architecture — self-contained CSS Modules (decided 2026-07-14)

The design system moves OFF the monolithic `console.css` incrementally. FabryMark is
the **first component to own its CSS** as a co-located **CSS Module**
(`src/ui/FabryMark.module.css`), imported by the component. Mechanism, all verified:

- esbuild 0.28 treats `*.module.css` as a local-CSS module natively (scopes class +
  `@keyframes` names, returns a name map). The `console/console` entry that imports
  FabryMark emits `dist/console/console.css` (scoped, minified). Verified: JS bundles
  `{mark:"n",animated:"e",hue:"i"}` matching the emitted `.n`/`.e`/`@keyframes i`.
- To avoid a filename clash with the emitted `console.css`, the hand-written monolith
  is copied to **`dist/console/console.base.css`** (legacy base, shrinks as components
  migrate, eventually retired). `console.html` links `console.base.css` then `console.css`.
- **Design tokens** (`--accent`, `--bg-card`, dark-mode `:root`) stay central in the
  monolith for now; each module owns only its own rules.
- Vitest 4 resolves `.module.css` too, so **tests import the module's `styles` object**
  and assert against `styles.mark`/`styles.animated` (never literal scoped names).
- **Future direction:** StyleX. CSS Modules is the stepping stone; the eventual target
  is atomic, compile-time StyleX once a compiler step is added.

## Component API

`src/ui/FabryMark.jsx` (imports `styles` from `./FabryMark.module.css`):

```
<FabryMark
  size?      // number → px width/height; default '1em' so the call site's font-size drives it
  animated?  // default true; false → no color cycle (static, inherits currentColor)
  class?     // extra classes (merged); wrappers keep owning position/extra transforms
  title?     // optional <title> for a11y; omitted → aria-hidden
/>
```

- Renders an inline `<svg viewBox="0 0 24 24">` with the **filled** four-point star path
  (`fill: currentColor`).
- `styles.mark` base: `display:inline-block; vertical-align:middle; flex:none;
  fill:currentColor`. No hard-coded `color` — it **inherits** the context color, so
  reduced-motion / static fall back to each surface's existing color (accent, white in the
  active rail, etc.). `width`/`height` come from the `size` prop.
- `animated` adds `styles.animated`.

## Animation (confirmed: always-on gentle cycle)

CSS-animated **solid fill** via `color` (fill tracks `currentColor`) — chosen over an SVG
`<linearGradient>` to avoid per-instance gradient-id collisions, and over `filter:hue-rotate`
which drifts out of the blue/purple band. Lives in `FabryMark.module.css` (local names
`.mark`/`.animated`, keyframe `hue` — all scoped by esbuild):

```css
.mark { display:inline-block; vertical-align:middle; flex:none; fill:currentColor; }
.animated { animation: hue 8s ease-in-out infinite; }
@keyframes hue {              /* stays strictly in blue → indigo → violet */
  0%, 100% { color:#4270db; } /* blue (matches --accent) */
  33%      { color:#5b6be6; }
  66%      { color:#8b5cf6; } /* violet */
}
@media (prefers-reduced-motion: reduce) { .animated { animation:none; } }
```

- ~8s loop = "slowly." No pink (`#ec4899` dropped per instruction).
- Under reduced-motion the animation is off and the mark shows the **inherited** color.
- **Verified visually** (2-frame screenshot): animated marks shift blue→indigo/violet
  while static rail marks stay fixed; filled star renders crisp at 18/40/72px; active
  rail = white-on-accent, idle = muted.
- **Star weight:** after review, the shared path is a **fuller** four-point star (inner
  radius ~4.8, `M12 2.5L15.4 8.6…`) chosen to match the previous `✦` glyph weight — the
  slimmer old-rail path made the Chat/Architect marks look thinner than before. One
  `STAR_PATH` constant drives every surface.

## Call-site changes

Each site swaps its glyph for `<FabryMark>` and keeps its wrapper class for size/position:

- `Sidebar` / `ChatHeader` / `Thread` greeting / `FabryPanel` (audit) / `Composer`:
  `{'✦'}` → `<FabryMark />`. Wrapper classes keep `font-size` (drives `1em`); their
  hard-coded `color` becomes the reduced-motion fallback.
- `FabryInput` (`agent-spark`): keeps the wrapper span, puts the mark inside —
  `<span class={'agent-spark' + loading}><FabryMark /></span>`. `.agent-spark` (stays in
  `console.css`) loses its text-clip gradient; the **span** owns position + the loading
  twinkle (a transform), the **child mark** owns the color cycle — so during loading the
  star twinkles AND keeps cycling color (two elements, two animations, no conflict, no
  cross-scope keyframe reference). `.agent-spark { color: var(--accent) }` is the child's
  reduced-motion fallback.
- `DiagnosisPanel`: `{'✨'}` → `<FabryMark />` (visual change sparkles→star, approved).
- `Rail`: `FABRY_ICON` const → `<FabryMark size={20} animated={false} />` (filled, static;
  inherits `.app-rail-icon` color chain incl. white-when-active).

## Backward compatibility

- Rail active/inactive/muted color behavior preserved (fill:currentColor inherits the
  same color chain that stroke:currentColor used).
- Reduced-motion still fully static; content-script `✨` untouched.
- No storage keys, no API, no persisted state involved. Pure presentational.

## Testing (all green: 239 files / 2493 tests)

- `tests/ui-fabry-mark.test.js`: imports the module `styles`; renders an `<svg>` carrying
  `styles.mark`; star path present; `animated` default adds `styles.animated`,
  `animated={false}` omits it; `size` sets width/height; `class`/`title` pass through.
- `tests/console-rail.test.js`: Fabry rail item's svg has `styles.mark` and is **not**
  `styles.animated` (static in the rail).
- `tests/fabry-header-files.test.js`: header mark assertion updated (svg present, no longer
  a `✦` text glyph).
- Full suite green; `dist/` rebuilt; CSS-module output + JS name-map linkage verified.

## Non-goals / YAGNI

No theming props, no per-surface palettes, no gradient variants, no size presets beyond
the `size`/`1em` mechanism. One mark, one animation, inheritable color.
