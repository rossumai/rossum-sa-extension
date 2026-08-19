// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/usage/track.js', () => ({ track: vi.fn(), trackOnce: vi.fn() }));

import { initScrollLock } from '../src/rossum/features/scroll-lock.js';
import { trackOnce } from '../src/usage/track.js';

// jsdom has no layout, so `scrollTop` is inert on a real element — the setter
// is a no-op without a scrolling box. Back it with a plain writable property so
// the module's reads and writes behave as they do in Chrome.
function scrollable(el) {
  Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
  return el;
}
const flush = () => new Promise((r) => { setTimeout(r, 0); vi.advanceTimersByTime(1); });

describe('initScrollLock', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    trackOnce.mockClear();
  });

  it('ignores non-HTMLElement arguments', () => {
    expect(() => initScrollLock(null)).not.toThrow();
    expect(() => initScrollLock(undefined)).not.toThrow();
    expect(() => initScrollLock({})).not.toThrow();
  });

  it('marks the element as attached and attaches event listeners', () => {
    const el = document.createElement('div');
    el.id = 'sidebar-scrollable';
    document.body.appendChild(el);

    const addSpy = vi.spyOn(el, 'addEventListener');
    initScrollLock(el);

    expect(el.__saScrollLockAttached).toBe(true);
    // At least wheel, touchstart, mousedown, keydown, scroll.
    const types = addSpy.mock.calls.map((c) => c[0]);
    expect(types).toEqual(expect.arrayContaining(['wheel', 'touchstart', 'mousedown', 'keydown', 'scroll']));
  });

  it('stops its monitor interval once the element is detached from the DOM', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    initScrollLock(el);

    el.remove();
    // Monitor interval fires every 2s; tick past one check.
    vi.advanceTimersByTime(2100);

    // Re-attach and ensure no further disconnect attempts throw — the cleanup
    // path (disconnect + clearInterval) has already run without errors.
    document.body.appendChild(el);
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
  });
  // The event moved out of initScrollLock on 2026-08-19. Attaching happens on
  // every Rossum page carrying a sidebar, so counting there measured "the
  // toggle is on" — enablement, which this extension deliberately stopped
  // reporting when the daily config snapshot was deleted.
  it('reports NOTHING merely for attaching to the sidebar', () => {
    const el = scrollable(document.createElement('div'));
    el.id = 'sidebar-scrollable';
    document.body.appendChild(el);
    initScrollLock(el);
    expect(trackOnce).not.toHaveBeenCalled();
  });

  it('reports the feature only once it really moves the scroll position back', async () => {
    const el = scrollable(document.createElement('div'));
    document.body.appendChild(el);
    initScrollLock(el);

    // The user scrolls down; the scroll handler records the position. The wheel
    // event matters: a scroll with no preceding input is not attributable to the
    // user, and is deliberately NOT adopted as the saved position.
    el.dispatchEvent(new Event('wheel'));
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
    expect(trackOnce).not.toHaveBeenCalled();

    // Rossum re-renders and resets the position without a scroll event, then
    // the content mutation arms the lock window and the feature restores.
    el.scrollTop = 0;
    el.appendChild(document.createElement('span'));
    await flush();

    expect(el.scrollTop).toBe(200);
    expect(trackOnce).toHaveBeenCalledWith('sa_rossum_scroll_lock');
  });

  it('does not report a re-application that changes nothing', async () => {
    const el = scrollable(document.createElement('div'));
    document.body.appendChild(el);
    initScrollLock(el);

    el.dispatchEvent(new Event('wheel'));
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
    // A mutation while the position is already correct: armLockWindow still
    // writes, but the write is a no-op and nothing was restored.
    el.appendChild(document.createElement('span'));
    await flush();

    expect(trackOnce).not.toHaveBeenCalled();
  });
  // The feature's whole stated purpose: Rossum re-renders the sidebar and resets
  // scrollTop to 0, and we put it back. Until 2026-08-19 the branch that does
  // this was unreachable, because the handler called markUserScrollActive()
  // before reading `now` — so `now <= userScrollUntil` always held and the
  // handler returned early every time.
  it('restores the position when Rossum resets it inside a lock window', async () => {
    const el = scrollable(document.createElement('div'));
    document.body.appendChild(el);
    initScrollLock(el);

    // The user scrolls the sidebar down.
    el.dispatchEvent(new Event('wheel'));
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));

    // They stop; the 250ms user-activity window lapses.
    vi.advanceTimersByTime(300);

    // A re-render arms the lock window.
    el.appendChild(document.createElement('span'));
    await flush();

    // Rossum resets the position from its own world — we only see the scroll.
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));

    expect(el.scrollTop).toBe(200);
    expect(trackOnce).toHaveBeenCalledWith('sa_rossum_scroll_lock');
  });

  it('never fights a genuine user scroll inside the lock window', async () => {
    const el = scrollable(document.createElement('div'));
    document.body.appendChild(el);
    initScrollLock(el);

    el.dispatchEvent(new Event('wheel'));
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(300);
    el.appendChild(document.createElement('span'));
    await flush();

    // Still inside the lock window, but this move follows real input, so it is
    // the user's and must be adopted as the new saved position.
    el.dispatchEvent(new Event('wheel'));
    el.scrollTop = 120;
    el.dispatchEvent(new Event('scroll'));
    expect(el.scrollTop).toBe(120);

    // ...and it really was saved: a later Rossum reset restores 120, not 200.
    vi.advanceTimersByTime(300);
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    expect(el.scrollTop).toBe(120);
  });

  it('keeps saving through momentum scrolling, which fires no further input events', async () => {
    const el = scrollable(document.createElement('div'));
    document.body.appendChild(el);
    initScrollLock(el);

    el.dispatchEvent(new Event('wheel'));
    el.scrollTop = 100;
    el.dispatchEvent(new Event('scroll'));
    // Momentum: scroll events keep arriving with no new wheel event. Each one is
    // within 250ms of the last, so the run must stay attributed to the user.
    for (const top of [150, 200, 250, 300]) {
      vi.advanceTimersByTime(100);
      el.scrollTop = top;
      el.dispatchEvent(new Event('scroll'));
    }
    expect(el.scrollTop).toBe(300);

    vi.advanceTimersByTime(300);
    el.appendChild(document.createElement('span'));
    await flush();
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    expect(el.scrollTop).toBe(300);
  });
  it('ignores a scroll it cannot attribute to the user, so a stray move is not saved', () => {
    const el = scrollable(document.createElement('div'));
    document.body.appendChild(el);
    initScrollLock(el);

    // No wheel/touch/mousedown/keydown first: this is somebody else's scroll
    // (Rossum, scrollIntoView, restoration). Adopting it as the saved position
    // is exactly how the reset used to be recorded as the user's intent.
    el.scrollTop = 400;
    el.dispatchEvent(new Event('scroll'));
    el.appendChild(document.createElement('span'));

    expect(trackOnce).not.toHaveBeenCalled();
  });
});
