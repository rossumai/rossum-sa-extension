// A short, cancellable scroll tween, used by both ends of the stage link so a
// reveal reads as movement rather than a teleport.
//
// Hand-rolled rather than `behavior: 'smooth'` for two reasons. The browser's
// smooth duration is not controllable and runs ~300-500ms in Chrome — too slow
// when a reveal fires on every hover. And CodeMirror's own
// `EditorView.scrollIntoView` effect has no behaviour option at all: it is
// always instant.
export const SCROLL_MS = 180;

export function easeOutCubic(t) {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

// Pure: the scroll offset partway through a tween. `elapsed >= duration` lands
// exactly on `to`, so the animation always finishes on the intended pixel.
export function tweenAt(from, to, elapsed, duration = SCROLL_MS) {
  if (!(duration > 0) || elapsed >= duration) return to;
  return from + (to - from) * easeOutCubic(elapsed / duration);
}

// (A `nearestScrollTop` helper lived here — the scrollTop that brings an element
// just inside a viewport, "nearest" semantics. Its only caller was the Stages
// pane following the editor's pointer, deleted 2026-08-14 when the text editor
// stopped moving the right pane.)

// How far below the top of the visible band a revealed line lands. Small enough
// to read as "at the top", but not zero: `stageLink.js` clamps the connector's
// editor endpoint EDGE_INSET (8px) inside the editor's clip box, and that endpoint
// is the line's vertical CENTRE. A line placed flush against the top edge sits
// only half a line-height below it — inside 8px once the line height is small —
// and the connector would then draw an "it is off screen" arrow at the clip edge
// for a stage sitting right there. 6px plus half a line clears the clamp at any
// line height.
export const REVEAL_TOP_INSET = 6;

// Pure: the scrollTop that brings a stage's opening line to the TOP of the visible
// band — or `null` when that line is already on screen and nothing should move.
//
// Both arguments are in the scroller's scrollTop coordinate space: `line` is the
// opening line's block ({top, bottom}), `view` the visible band ({scrollTop,
// height}).
//
// `null` is the whole point of this helper (owner, 2026-08-14): hovering a
// Stages-view section used to scroll the stage to the MIDDLE of the editor
// unconditionally, so a stage you could already see travelled on every hover. A
// line touching either edge counts as visible, which also makes a reveal
// idempotent — re-hovering the stage it just revealed asks for nothing.
export function revealScrollTop(line, view) {
  if (!line || !view) return null;
  const { scrollTop, height } = view;
  if (line.top >= scrollTop && line.bottom <= scrollTop + height) return null;
  return line.top - REVEAL_TOP_INSET;
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// One in-flight tween per element, so rapid hovers retarget instead of fighting.
const running = new WeakMap();

export function animateScrollTop(el, top, { duration = SCROLL_MS, reduced } = {}) {
  if (!el) return;
  const prev = running.get(el);
  if (prev != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(prev);
  running.delete(el);

  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const target = Math.max(0, Math.min(top, max));
  const from = el.scrollTop;

  const skip = (reduced == null ? prefersReducedMotion() : reduced)
    || typeof requestAnimationFrame !== 'function'
    || typeof performance === 'undefined'
    || Math.abs(target - from) < 2; // not worth animating, and avoids a visible nudge
  if (skip) { el.scrollTop = target; return; }

  const start = performance.now();
  const step = (now) => {
    const elapsed = now - start;
    el.scrollTop = tweenAt(from, target, elapsed, duration);
    if (elapsed < duration) running.set(el, requestAnimationFrame(step));
    else running.delete(el);
  };
  running.set(el, requestAnimationFrame(step));
}
