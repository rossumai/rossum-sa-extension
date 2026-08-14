// tests/training-tether.test.js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  showTether, hideTether, resolveAnchor, TETHER_SVG_ID, TETHER_HINT_ID,
} from '../src/rossum/features/training-tether.js';

const CARD_RECT = { left: 916, top: 584, right: 1184, bottom: 784 }; // matches the card's fixed bottom:16/right:16, width 268
const VISIBLE_TARGET = { left: 100, top: 50, right: 220, bottom: 80 }; // on screen, clear of the card
const BELOW_VIEWPORT_TARGET = { left: 100, top: 900, right: 220, bottom: 950 }; // past an 800px-tall viewport

function stubRect(el, rect) {
  el.getBoundingClientRect = () => rect;
}

function setUpCardAndTarget(targetRect, href = '/queues/1') {
  document.body.innerHTML = `<div id="card"></div><a href="${href}">Q</a>`;
  const card = document.getElementById('card');
  const target = document.querySelector(`a[href="${href}"]`);
  stubRect(card, CARD_RECT);
  stubRect(target, targetRect);
  return { card, target };
}

// Move the pointer somewhere in viewport coordinates. Only a MOUNTED tether is
// listening, so this is only recorded after a showTether call — which is the
// real sequence too: the listener lives with the tether.
function movePointerTo(x, y) {
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y }));
}
const CARD_CENTRE = [1050, 684]; // inside CARD_RECT
const AWAY_FROM_CARD = [100, 100];

// The tether only draws while the card is engaged, so every "it renders X" test
// has to hover first. Two calls, mirroring what the quest loop actually does:
// the first mounts the pointer listener, the second is the next tick's re-render
// — by which time the pointer is known and the line paints synchronously.
function showHovered(anchor, card, opts = {}) {
  const args = { retries: 0, cardEl: card, ...opts };
  showTether(anchor, args);
  movePointerTo(...CARD_CENTRE);
  showTether(anchor, args);
}

beforeEach(() => {
  document.body.innerHTML = '';
  hideTether();
  window.innerWidth = 1200;
  window.innerHeight = 800;
});

describe('resolveAnchor', () => {
  it('finds an element by data-cy', () => {
    document.body.innerHTML = '<button data-cy="add-section-button">Add</button>';
    expect(resolveAnchor({ cy: 'add-section-button' }, document).tagName).toBe('BUTTON');
  });

  it('finds an anchor by href substring', () => {
    document.body.innerHTML = '<a href="/extensions/my-extensions">Ext</a>';
    expect(resolveAnchor({ hrefIncludes: '/extensions/my-extensions' }, document).tagName).toBe('A');
  });

  it('prefers cy when both are given', () => {
    document.body.innerHTML = '<button data-cy="x">B</button><a href="/queues/1">Q</a>';
    const found = resolveAnchor({ cy: 'x', hrefIncludes: '/queues/' }, document);
    expect(found.tagName).toBe('BUTTON');
  });

  // Rossum's Automation-section tabs really are named `tab-automation.aiEngines`
  // — a DOT, unlike every other hook in the curriculum. Both code paths must
  // survive it, and they do so for different reasons: under jsdom `CSS.escape`
  // is absent, so this exercises the FALLBACK, where an unescaped dot is
  // already inert inside a quoted attribute selector; Chrome takes the
  // `CSS.escape` path, emitting `\.`, which that selector reads back as a
  // literal dot — verified against the live page, since jsdom cannot cover it.
  it('resolves a data-cy value containing a dot', () => {
    document.body.innerHTML = '<button data-cy="tab-automation.aiEngines">AI engines</button>';
    expect(resolveAnchor({ cy: 'tab-automation.aiEngines' }, document).tagName).toBe('BUTTON');
  });

  it('does not treat a dotted data-cy as a class selector', () => {
    document.body.innerHTML = '<div data-cy="tab-automation" class="aiEngines">x</div>';
    expect(resolveAnchor({ cy: 'tab-automation.aiEngines' }, document)).toBe(null);
  });

  it('returns null when nothing matches', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    expect(resolveAnchor({ hrefIncludes: '/extensions' }, document)).toBe(null);
  });

  it('never matches by class or id — only data-cy or href', () => {
    document.body.innerHTML = '<div class="extensions" id="extensions">x</div>';
    expect(resolveAnchor({ hrefIncludes: '/extensions' }, document)).toBe(null);
    expect(resolveAnchor({ cy: 'extensions' }, document)).toBe(null);
  });
});

describe('showTether', () => {
  it('renders nothing when the step has no anchor', () => {
    showTether(undefined);
    expect(document.getElementById(TETHER_SVG_ID)).toBe(null);
    expect(document.getElementById(TETHER_HINT_ID)).toBe(null);
  });

  it('renders nothing when the anchor cannot be resolved', () => {
    showTether({ hrefIncludes: '/nope' }, { retries: 0 });
    expect(document.getElementById(TETHER_SVG_ID)).toBe(null);
    expect(document.getElementById(TETHER_HINT_ID)).toBe(null);
  });

  it('renders a path — not the hint — for a resolved, visible target; the overlay never intercepts clicks', () => {
    const { card } = setUpCardAndTarget(VISIBLE_TARGET);
    showHovered({ hrefIncludes: '/queues/' }, card);

    const svg = document.getElementById(TETHER_SVG_ID);
    expect(svg).toBeTruthy();
    expect(svg.style.pointerEvents).toBe('none');
    const path = svg.querySelector('path');
    expect(path.getAttribute('d').length).toBeGreaterThan(0);
    expect(document.getElementById(TETHER_HINT_ID)).toBe(null);
  });

  it('renders the hint — not a path — for a resolved but off-screen target, with the correct direction', () => {
    const { card } = setUpCardAndTarget(BELOW_VIEWPORT_TARGET);
    showHovered({ hrefIncludes: '/queues/' }, card);

    expect(document.getElementById(TETHER_SVG_ID)).toBe(null);
    const hint = document.getElementById(TETHER_HINT_ID);
    expect(hint).toBeTruthy();
    expect(hint.style.pointerEvents).toBe('none');
    expect(hint.textContent).toContain('below');
  });

  it('renders nothing when the target is on screen but hidden under the card (overlap), not a path either', () => {
    const underCard = { left: 950, top: 600, right: 1000, bottom: 650 };
    const { card } = setUpCardAndTarget(underCard);
    showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: card });

    expect(document.getElementById(TETHER_SVG_ID)).toBe(null);
    expect(document.getElementById(TETHER_HINT_ID)).toBe(null);
  });

  it('replaces rather than stacks tethers on repeated calls', () => {
    const { card } = setUpCardAndTarget(VISIBLE_TARGET);
    showHovered({ hrefIncludes: '/queues/' }, card);
    showHovered({ hrefIncludes: '/queues/' }, card);
    expect(document.querySelectorAll(`#${TETHER_SVG_ID}`)).toHaveLength(1);
  });

  it('hideTether removes the path overlay', () => {
    const { card } = setUpCardAndTarget(VISIBLE_TARGET);
    showHovered({ hrefIncludes: '/queues/' }, card);
    expect(document.getElementById(TETHER_SVG_ID)).toBeTruthy(); // it was there to remove
    hideTether();
    expect(document.getElementById(TETHER_SVG_ID)).toBe(null);
  });

  it('hideTether removes the hint pill', () => {
    const { card } = setUpCardAndTarget(BELOW_VIEWPORT_TARGET);
    showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: card });
    hideTether();
    expect(document.getElementById(TETHER_HINT_ID)).toBe(null);
  });

  it('a later call supersedes an earlier one still retrying, so a stale resolution never resurrects a tether', () => {
    // showTether() is called on every ~1.5s tick with the CURRENT step's anchor.
    // If step A's anchor is briefly absent (SPA still rendering) and the trainee
    // moves to step B before A's retry loop gives up, A's retry must not mount
    // anything later even if A's target eventually does show up.
    vi.useFakeTimers();
    try {
      showTether({ hrefIncludes: '/foo' }, { retries: 5, delayMs: 10 }); // step A — target not in the DOM yet
      const { card } = setUpCardAndTarget(VISIBLE_TARGET, '/queues/1');
      showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: card }); // step B supersedes A immediately
      const svgAfterB = document.getElementById(TETHER_SVG_ID);
      expect(svgAfterB).toBeTruthy();

      // Appends without re-parsing (unlike `innerHTML +=`, which would replace
      // every existing node — including B's own svg — with an identical-
      // looking but distinct one, and falsely fail the identity check below).
      document.body.insertAdjacentHTML('beforeend', '<a href="/foo">F</a>'); // A's target finally renders
      vi.runAllTimers(); // let A's still-pending retry run against it

      // A's superseded retry must never mount: still exactly B's one svg.
      expect(document.querySelectorAll(`#${TETHER_SVG_ID}`)).toHaveLength(1);
      expect(document.getElementById(TETHER_SVG_ID)).toBe(svgAfterB);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hideTether detaches its scroll/resize listeners', () => {
    const { card } = setUpCardAndTarget(VISIBLE_TARGET);
    const addSpy = { scroll: 0, resize: 0 };
    const removeSpy = { scroll: 0, resize: 0 };
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = (type, ...rest) => { if (type in addSpy) addSpy[type]++; return origAdd(type, ...rest); };
    window.removeEventListener = (type, ...rest) => { if (type in removeSpy) removeSpy[type]++; return origRemove(type, ...rest); };
    try {
      showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: card });
      expect(addSpy.scroll).toBe(1);
      expect(addSpy.resize).toBe(1);
      hideTether();
      expect(removeSpy.scroll).toBe(1);
      expect(removeSpy.resize).toBe(1);
    } finally {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
    }
  });
});

describe('the engagement gate', () => {
  // A fresh module instance guarantees the tracked pointer starts as null —
  // it is module state that deliberately OUTLIVES any single tether, so a
  // previous test's hover would otherwise still count as engagement here.
  const freshModule = async () => {
    vi.resetModules();
    return import('../src/rossum/features/training-tether.js');
  };

  it('draws nothing at all until the card is engaged', async () => {
    const mod = await freshModule();
    const { card } = setUpCardAndTarget(VISIBLE_TARGET);
    mod.showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: card });
    expect(document.getElementById(TETHER_SVG_ID)).toBe(null);
    expect(document.getElementById(TETHER_HINT_ID)).toBe(null);
  });

  it('withholds the off-screen hint too, not just the line', async () => {
    const mod = await freshModule();
    const { card } = setUpCardAndTarget(BELOW_VIEWPORT_TARGET);
    mod.showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: card });
    expect(document.getElementById(TETHER_HINT_ID)).toBe(null);
  });

  it('draws while the pointer is over the card and clears once it leaves', () => {
    const { card } = setUpCardAndTarget(VISIBLE_TARGET);
    showHovered({ hrefIncludes: '/queues/' }, card);
    expect(document.getElementById(TETHER_SVG_ID)).toBeTruthy();

    movePointerTo(...AWAY_FROM_CARD);
    showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: card });
    expect(document.getElementById(TETHER_SVG_ID)).toBe(null);
  });

  // The card is REMOVED and rebuilt on every ~1.5s tick, so a hover held
  // perfectly still spans several card elements. Tracking a position rather
  // than binding mouseenter to a node is what keeps the line up across that.
  it('survives the card element being replaced under a stationary pointer', () => {
    const { card } = setUpCardAndTarget(VISIBLE_TARGET);
    showHovered({ hrefIncludes: '/queues/' }, card);
    expect(document.getElementById(TETHER_SVG_ID)).toBeTruthy();

    card.remove();                                  // what renderCard does every tick
    const rebuilt = document.createElement('div');
    rebuilt.id = 'card';
    stubRect(rebuilt, CARD_RECT);
    document.body.appendChild(rebuilt);
    showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: rebuilt });

    expect(document.getElementById(TETHER_SVG_ID)).toBeTruthy();
  });

  it('counts keyboard focus inside the card as engagement', async () => {
    const mod = await freshModule();
    document.body.innerHTML = '<div id="card"><button id="dismiss">x</button></div><a href="/queues/1">Q</a>';
    const card = document.getElementById('card');
    stubRect(card, CARD_RECT);
    stubRect(document.querySelector('a[href="/queues/1"]'), VISIBLE_TARGET);
    document.getElementById('dismiss').focus();

    mod.showTether({ hrefIncludes: '/queues/' }, { retries: 0, cardEl: card });
    expect(document.getElementById(TETHER_SVG_ID)).toBeTruthy();
  });
});
