// A tether — a dashed connector from the quest card to the current step's
// target — replacing the earlier single ◀ arrow. Two displays share one
// resolve/retry/reposition lifecycle: when the target is on screen and clear
// of the card, a curved dashed line runs from the card to it; when the
// target exists but is scrolled out of view, a small pill names which way to
// scroll instead. Geometry is pure (src/training/tether.js); this module is
// the DOM half — resolving the anchor, mounting/positioning the SVG or the
// pill, and tearing both down.
//
// Anchor resolution tries TWO handles, in order:
//   - `anchor.cy`           → `[data-cy="…"]`
//   - `anchor.hrefIncludes` → `a[href*="…"]` (unchanged from the old arrow)
// Rossum ships ~274 elements carrying semantic `data-cy` hooks — the durable
// handle for controls that are not links (buttons, tabs) — LIVE-VERIFIED:
// add-section-button, queue-settings-header-tab-fields, extensions-navtab,
// edit-json-schema. `hrefIncludes` stays exactly as before: Rossum's own
// navigation is built from real `<a href>` elements, not JS-only routing
// (src/devtools/detect.js relies on the same contract). Rossum's CSS class
// names are not a contract this repo owns, and are never matched on.
//
// If neither resolves within the retry window, NOTHING renders — no line, no
// pill — and the quest card's plain-text hint carries the step regardless. A
// stale hook must never block a trainee.

import { tetherGeometry, offscreenHint } from '../../training/tether.js';
import { arrowHeadPath } from '../../ui/connectorPath.js';

export const TETHER_SVG_ID = 'rossum-sa-extension-training-tether-svg';
export const TETHER_HINT_ID = 'rossum-sa-extension-training-tether-hint';
const PATH_ID = 'rossum-sa-extension-training-tether-path';
const ARROW_ID = 'rossum-sa-extension-training-tether-arrow';
const SVG_NS = 'http://www.w3.org/2000/svg';

let cleanup = null;
// Same pattern as the old arrow's generation counter: bumped on every
// hideTether()/showTether() so a retry loop superseded by a later call can
// never mount stale geometry — training-quest.js calls showTether() on every
// ~1.5s tick with the step's CURRENT anchor, so an in-flight retry for a step
// the trainee has already moved past is routine, not exceptional.
let generation = 0;

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  // Fallback for runtimes without CSS.escape: escape the characters that
  // would otherwise break out of the attribute-selector string.
  return String(value).replace(/["\\]/g, '\\$&');
}

export function resolveAnchor(anchor, doc = document) {
  if (!anchor) return null;
  if (anchor.cy) {
    const byCy = doc.querySelector(`[data-cy="${cssEscape(anchor.cy)}"]`);
    if (byCy) return byCy;
  }
  if (anchor.hrefIncludes) {
    const needle = anchor.hrefIncludes;
    const anchors = doc.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (href.includes(needle)) return a;
    }
  }
  return null;
}

// The connector's colour, taken from the quest card's own gradient (#2f4fa8 →
// #5b8af0) rather than the amber it used to be, which matched nothing on the
// card and washed out badly against Rossum's white dashboard. This is the
// gradient's light end: it holds up on a pale background and still reads on a
// dark one, and it puts the tether in the same accent language as the MDH
// Stages connector it now shares its geometry with.
const STROKE = '#5b8af0';

// Quieter than the MDH connector it borrows its shape from (2px / .75 opacity /
// dashed 6 4), and deliberately so: that line is summoned by hovering the very
// thing it explains, inside a panel built for it. This one lies across whatever
// Rossum is rendering. Now that it appears only on a deliberate hover it no
// longer has to compete for attention at rest — it can afford to be a whisper.
const OPACITY = '0.55';
const SHADOW = 'drop-shadow(0 1px 1px rgba(0,0,0,.16))';

// The tether is drawn ONLY while the trainee is engaged with the quest card
// (owner, 2026-08-14). Engagement is tracked as a POINTER POSITION rather than
// with mouseenter/mouseleave on the card, because `renderCard` removes and
// recreates that element on every ~1.5s tick: listeners bound to it die with
// it, and a fresh node inserted under a stationary pointer does not re-fire
// mouseenter — so a hover held still across a tick would silently lose the
// tether. A module-level position survives the swap, and `showTether` re-runs
// right after each render, so the line simply re-appears.
//
// null means "we have never seen the pointer" (or it left the window), which
// reads as not-engaged: no tether until the trainee actually moves onto the card.
let pointer = null;

const pointInRect = (p, r) => !!p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

// Keyboard users cannot hover, and the card holds a focusable control (its
// dismiss button), so focus inside the card counts as engagement too. Without
// this the guidance would be reachable by pointer only.
const focusWithin = (cardEl) => {
  const a = document.activeElement;
  return !!a && a !== document.body && cardEl.contains(a);
};

// The one case a tracked position cannot answer: the pointer is ALREADY resting
// on the card the first time a tether mounts, so no pointermove has ever fired
// and `pointer` is still null. Asking the engine directly covers it, and costs
// nothing when it is false. jsdom does not implement :hover — it answers false
// rather than throwing — so this is a Chrome-only assist and the tests drive the
// pointer path instead.
const hoverMatches = (cardEl) => {
  try { return cardEl.matches(':hover'); } catch { return false; }
};

function clearVisuals() {
  document.getElementById(TETHER_SVG_ID)?.remove();
  document.getElementById(TETHER_HINT_ID)?.remove();
}

export function hideTether() {
  generation++;
  clearVisuals();
  if (cleanup) { cleanup(); cleanup = null; }
}

function buildSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = TETHER_SVG_ID;
  Object.assign(svg.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    zIndex: '2147483644', // just below the card (2147483645)
    pointerEvents: 'none', // never intercepts a click meant for Rossum's UI
  });

  // Styling follows the MDH Stages connector (.stage-link-line in console.css):
  // 2px, dashed 6 4, round joins, and — the part the owner asked for — NO
  // animation at all. The marching dashes this used to run drew the eye
  // continuously to a hint the trainee had already read; the Stages connector
  // has never animated and reads as a calm guide line instead.
  const path = document.createElementNS(SVG_NS, 'path');
  path.id = PATH_ID;
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', STROKE);
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-dasharray', '5 5');
  path.setAttribute('stroke-linecap', 'butt');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('opacity', OPACITY);
  // The one deliberate departure from .stage-link-line: that connector is drawn
  // over a panel this stylesheet controls, while the tether floats over whatever
  // Rossum happens to be rendering, light or dark. A faint shadow keeps the line
  // legible on a busy background without reading as a highlight.
  path.style.filter = SHADOW;
  svg.appendChild(path);

  // An arrowhead, not the old dot: it names a direction as well as a place, so
  // the end of the line points AT the control instead of merely resting on it.
  const arrow = document.createElementNS(SVG_NS, 'path');
  arrow.id = ARROW_ID;
  arrow.setAttribute('fill', STROKE);
  arrow.setAttribute('opacity', OPACITY);
  arrow.style.filter = SHADOW;
  svg.appendChild(arrow);

  return svg;
}

function buildHint(direction) {
  const hint = document.createElement('div');
  hint.id = TETHER_HINT_ID;
  hint.textContent = direction === 'down' ? '\u2193 Your next step is below' : '\u2191 Your next step is above';
  // NON-INTERACTIVE, like everything else this feature injects: this pill
  // must never intercept a click meant for Rossum's UI. It looks like it
  // could double as a "scroll to it" button — do not turn it into one
  // without separately and deliberately deciding this feature should ever
  // intercept input; that has never been true of the quest card or the old
  // arrow, and this pill is not an exception.
  Object.assign(hint.style, {
    position: 'fixed',
    left: '50%',
    transform: 'translateX(-50%)',
    top: direction === 'up' ? '10px' : 'auto',
    bottom: direction === 'down' ? '10px' : 'auto',
    zIndex: '2147483644',
    pointerEvents: 'none',
    padding: '5px 12px',
    borderRadius: '999px',
    color: '#fff',
    fontSize: '11px',
    fontWeight: '700',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: 'linear-gradient(150deg, #2f4fa8, #4270db 55%, #5b8af0)',
    boxShadow: '0 6px 18px rgba(20, 30, 60, 0.32)',
  });
  return hint;
}

export function showTether(anchor, { retries = 6, delayMs = 300, cardEl } = {}) {
  hideTether();
  if (!anchor?.cy && !anchor?.hrefIncludes) return;

  const myGeneration = generation; // identity of THIS call, fixed at the point hideTether() just bumped it
  let attempt = 0;

  const place = () => {
    if (myGeneration !== generation) return; // superseded — never resurrect a stale tether
    const target = resolveAnchor(anchor);
    if (!target) {
      if (attempt++ < retries) setTimeout(place, delayMs);
      return; // either scheduled a retry, or the SPA never rendered it in time
    }
    mount(target);
  };

  function mount(target) {
    const reposition = () => {
      if (myGeneration !== generation) return;
      if (!target.isConnected) { hideTether(); return; } // the anchor left the DOM — don't strand anything at 0,0

      const targetRect = target.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const cardRect = cardEl?.isConnected ? cardEl.getBoundingClientRect() : null;

      // The engagement gate, ahead of any geometry: it governs the off-screen
      // hint pill exactly as it governs the line, since both are the same piece
      // of guidance answering "where do I go next" in two situations.
      if (!cardRect || !(pointInRect(pointer, cardRect) || hoverMatches(cardEl) || focusWithin(cardEl))) {
        clearVisuals();
        return;
      }

      const geo = tetherGeometry(cardRect, targetRect, viewport);

      clearVisuals();
      if (geo) {
        const svg = buildSvg();
        svg.querySelector(`#${PATH_ID}`).setAttribute('d', geo.d);
        const head = arrowHeadPath(geo.arrow.x, geo.arrow.y, geo.arrow.dir);
        svg.querySelector(`#${ARROW_ID}`).setAttribute('d', head || '');
        document.body.appendChild(svg);
        return;
      }
      const hint = offscreenHint(targetRect, viewport);
      if (hint) document.body.appendChild(buildHint(hint.direction));
      // else: on screen but overlapping the card, or no card rect available —
      // render nothing, same as an unresolved anchor. A connector to
      // something hidden under the card teaches nothing either.
    };
    reposition();

    let frame = 0;
    const onScrollOrResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reposition);
    };
    // Passive and rAF-throttled: the handler stores two numbers and defers the
    // work, so tracking the pointer across the whole page costs a coalesced
    // frame rather than a repaint per event.
    const onPointerMove = (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      onScrollOrResize();
    };
    // The pointer leaving the window would otherwise leave its last position
    // frozen over the card, holding the tether open on a page nobody is on.
    const onPointerOut = (e) => {
      if (e.relatedTarget) return; // moved to another element, not out of the window
      pointer = null;
      onScrollOrResize();
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('focusin', onScrollOrResize, true);
    document.addEventListener('focusout', onScrollOrResize, true);
    cleanup = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('focusin', onScrollOrResize, true);
      document.removeEventListener('focusout', onScrollOrResize, true);
    };
  }

  place();
}
