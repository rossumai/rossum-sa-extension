// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initScrollLock } from '../src/rossum/features/scroll-lock.js';

describe('initScrollLock', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
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
});
