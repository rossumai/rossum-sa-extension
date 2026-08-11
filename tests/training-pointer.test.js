// tests/training-pointer.test.js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { showPointer, hidePointer, ARROW_ID, resolveAnchor } from '../src/rossum/features/training-pointer.js';

beforeEach(() => {
  document.body.innerHTML = '';
  hidePointer();
});

describe('resolveAnchor', () => {
  it('finds an anchor by href substring', () => {
    document.body.innerHTML = '<a href="/extensions/my-extensions">Ext</a>';
    expect(resolveAnchor({ hrefIncludes: '/extensions/my-extensions' }, document).tagName).toBe('A');
  });

  it('returns null when nothing matches', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    expect(resolveAnchor({ hrefIncludes: '/extensions' }, document)).toBe(null);
  });

  it('never matches by class or id — hrefs only', () => {
    document.body.innerHTML = '<div class="extensions" id="extensions">x</div>';
    expect(resolveAnchor({ hrefIncludes: '/extensions' }, document)).toBe(null);
  });
});

describe('showPointer', () => {
  it('renders no arrow when the step has no anchor', () => {
    showPointer(undefined);
    expect(document.getElementById(ARROW_ID)).toBe(null);
  });

  it('renders no arrow when the anchor cannot be resolved', () => {
    showPointer({ hrefIncludes: '/nope' }, { retries: 0 });
    expect(document.getElementById(ARROW_ID)).toBe(null);
  });

  it('renders an arrow next to a resolved anchor', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    const arrow = document.getElementById(ARROW_ID);
    expect(arrow).toBeTruthy();
    expect(arrow.style.position).toBe('fixed');
  });

  it('never intercepts clicks', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    expect(document.getElementById(ARROW_ID).style.pointerEvents).toBe('none');
  });

  it('replaces rather than stacks arrows on repeated calls', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    expect(document.querySelectorAll(`#${ARROW_ID}`)).toHaveLength(1);
  });

  it('hidePointer removes it', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
    hidePointer();
    expect(document.getElementById(ARROW_ID)).toBe(null);
  });

  it('a later call supersedes an earlier one still retrying, so a stale resolution never resurrects an arrow', () => {
    // showPointer() is called on every ~1.5s tick with the CURRENT step's anchor.
    // If step A's anchor is briefly absent (SPA still rendering) and the trainee
    // moves to step B before A's retry loop gives up, A's retry must not mount
    // anything later even if A's target eventually does show up — otherwise a
    // slow SPA render can paint a second, wrong arrow on top of B's.
    // Fake timers drive this deterministically instead of a real-clock sleep.
    vi.useFakeTimers();
    try {
      showPointer({ hrefIncludes: '/foo' }, { retries: 5, delayMs: 10 }); // step A — target not in the DOM yet
      document.body.innerHTML = '<a href="/queues/1">Q</a>';
      showPointer({ hrefIncludes: '/queues/' }, { retries: 0 }); // step B supersedes A immediately
      const arrowAfterB = document.getElementById(ARROW_ID);
      expect(arrowAfterB).toBeTruthy();

      // Appends without re-parsing (unlike `innerHTML +=`, which would replace
      // every existing node — including B's own arrow — with an identical-
      // looking but distinct one, and falsely fail the identity check below).
      document.body.insertAdjacentHTML('beforeend', '<a href="/foo">F</a>'); // A's target finally renders
      vi.runAllTimers(); // let A's still-pending retry run against it

      // A's superseded retry must never mount: still exactly B's one arrow.
      expect(document.querySelectorAll(`#${ARROW_ID}`)).toHaveLength(1);
      expect(document.getElementById(ARROW_ID)).toBe(arrowAfterB);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hidePointer detaches its scroll/resize listeners', () => {
    document.body.innerHTML = '<a href="/queues/1">Q</a>';
    const addSpy = { scroll: 0, resize: 0 };
    const removeSpy = { scroll: 0, resize: 0 };
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = (type, ...rest) => { if (type in addSpy) addSpy[type]++; return origAdd(type, ...rest); };
    window.removeEventListener = (type, ...rest) => { if (type in removeSpy) removeSpy[type]++; return origRemove(type, ...rest); };
    try {
      showPointer({ hrefIncludes: '/queues/' }, { retries: 0 });
      expect(addSpy.scroll).toBe(1);
      expect(addSpy.resize).toBe(1);
      hidePointer();
      expect(removeSpy.scroll).toBe(1);
      expect(removeSpy.resize).toBe(1);
    } finally {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
    }
  });
});
