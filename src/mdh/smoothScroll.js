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
// stopped moving the right pane. The remaining caller, JsonEditor's revealStage,
// centres its target instead, so nothing computes a nearest offset any more.)

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
