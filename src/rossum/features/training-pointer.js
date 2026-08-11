// A single arrow pointing at the current step's target.
//
// Anchoring is by HREF ONLY. Verified live: Rossum's navigation really is
// built from real `<a href>` elements (/documents, /extensions/my-extensions,
// /queues/<id>/…, /document/<id>) matching the route contract this extension
// already relies on elsewhere (src/devtools/detect.js). Rossum's class names
// are not a contract this repo owns, so they are never matched on.
//
// If the anchor does not resolve within the retry window, NO arrow renders —
// the quest card's plain-text hint carries the step regardless. A stale
// selector must never block a trainee.

export const ARROW_ID = 'rossum-sa-extension-training-arrow';

let cleanup = null;
// Bumped by every hidePointer()/showPointer() call. A retry loop captures the
// generation it was started under and checks it before ever touching the DOM,
// so a call that supersedes an earlier still-retrying one can never have that
// earlier call's resolution show up later — training-quest.js calls
// showPointer() on every ~1.5s tick with the step's CURRENT anchor, so an
// in-flight retry for a step the trainee has already moved past is routine,
// not exceptional.
let generation = 0;

export function resolveAnchor(anchor, doc = document) {
  if (!anchor?.hrefIncludes) return null;
  const needle = anchor.hrefIncludes;
  const anchors = doc.querySelectorAll('a[href]');
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (href.includes(needle)) return a;
  }
  return null;
}

export function hidePointer() {
  generation++;
  document.getElementById(ARROW_ID)?.remove();
  if (cleanup) { cleanup(); cleanup = null; }
}

export function showPointer(anchor, { retries = 6, delayMs = 300 } = {}) {
  hidePointer();
  if (!anchor?.hrefIncludes) return;

  const myGeneration = generation; // identity of THIS call, fixed at the point hidePointer() just bumped it
  let attempt = 0;

  const place = () => {
    if (myGeneration !== generation) return; // superseded — never resurrect a stale arrow
    const target = resolveAnchor(anchor);
    if (!target) {
      if (attempt++ < retries) setTimeout(place, delayMs);
      return; // either scheduled a retry, or the SPA never rendered it in time
    }
    mount(target);
  };

  function mount(target) {
    const arrow = document.createElement('div');
    arrow.id = ARROW_ID;
    arrow.textContent = '◀'; // '◀' — points left, at the target on its right
    Object.assign(arrow.style, {
      position: 'fixed',
      zIndex: '2147483644',
      pointerEvents: 'none',
      color: '#ffd479',
      fontSize: '18px',
      lineHeight: '1',
      textShadow: '0 2px 6px rgba(0,0,0,.4)',
      transition: 'top .12s, left .12s',
    });
    document.body.appendChild(arrow);

    const reposition = () => {
      if (myGeneration !== generation) return;
      if (!target.isConnected) { hidePointer(); return; } // the anchor left the DOM — don't strand the arrow at 0,0
      const r = target.getBoundingClientRect();
      arrow.style.top = `${r.top + r.height / 2 - 9}px`;
      arrow.style.left = `${r.right + 6}px`;
    };
    reposition();

    let frame = 0;
    const onScrollOrResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reposition);
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    cleanup = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }

  place();
}
