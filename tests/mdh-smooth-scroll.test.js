import { describe, it, expect, vi, afterEach } from 'vitest';
import { easeOutCubic, tweenAt, nearestScrollTop, animateScrollTop, SCROLL_MS } from '../src/mdh/smoothScroll.js';

describe('easeOutCubic', () => {
  it('runs 0 → 1 and decelerates', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    // Ease-OUT: more than half the distance is covered in the first half.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('clamps out-of-range input rather than overshooting', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe('tweenAt', () => {
  it('starts at `from` and lands exactly on `to`', () => {
    expect(tweenAt(100, 500, 0)).toBe(100);
    expect(tweenAt(100, 500, SCROLL_MS)).toBe(500);
    // Past the end stays put — no drift if a frame lands late.
    expect(tweenAt(100, 500, SCROLL_MS * 3)).toBe(500);
  });

  it('is monotonic between the endpoints', () => {
    const a = tweenAt(0, 100, 40);
    const b = tweenAt(0, 100, 90);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(100);
  });

  it('lands immediately when the duration is zero', () => {
    expect(tweenAt(0, 100, 0, 0)).toBe(100);
  });

  it('handles scrolling upward as well as down', () => {
    expect(tweenAt(500, 100, SCROLL_MS)).toBe(100);
    expect(tweenAt(500, 100, 40)).toBeLessThan(500);
  });
});

describe('nearestScrollTop', () => {
  // A 400px-tall pane sitting at viewport y=100..500, currently scrolled to 200.
  const VIEW_TOP = 100, VIEW_BOTTOM = 500, SCROLL = 200;

  it('does not move an element already fully visible', () => {
    expect(nearestScrollTop(200, 300, VIEW_TOP, VIEW_BOTTOM, SCROLL)).toBe(SCROLL);
  });

  it('scrolls up to reach an element above the view', () => {
    const t = nearestScrollTop(40, 140, VIEW_TOP, VIEW_BOTTOM, SCROLL);
    expect(t).toBeLessThan(SCROLL);
    expect(t).toBe(SCROLL + (40 - VIEW_TOP) - 8);
  });

  it('scrolls down to reach an element below the view', () => {
    const t = nearestScrollTop(520, 600, VIEW_TOP, VIEW_BOTTOM, SCROLL);
    expect(t).toBeGreaterThan(SCROLL);
  });

  it('keeps the TOP of an over-tall element in view rather than aligning its bottom', () => {
    // A 900px section in a 400px pane: aligning the bottom would push the start
    // of the stage — the part the connector points at — off the top.
    const t = nearestScrollTop(120, 1020, VIEW_TOP, VIEW_BOTTOM, SCROLL);
    expect(t).toBeLessThanOrEqual(SCROLL + (120 - VIEW_TOP) - 8);
  });
});

describe('animateScrollTop', () => {
  const rafs = [];
  const el = (over = {}) => ({ scrollTop: 0, scrollHeight: 2000, clientHeight: 400, ...over });

  afterEach(() => { rafs.length = 0; vi.unstubAllGlobals(); });

  it('jumps straight to the target when motion is reduced', () => {
    const e = el();
    animateScrollTop(e, 300, { reduced: true });
    expect(e.scrollTop).toBe(300);
  });

  it('clamps the target into the scrollable range', () => {
    const e = el();
    animateScrollTop(e, 99999, { reduced: true });
    expect(e.scrollTop).toBe(2000 - 400);
    const e2 = el();
    animateScrollTop(e2, -50, { reduced: true });
    expect(e2.scrollTop).toBe(0);
  });

  it('does not animate a sub-2px move (avoids a visible nudge)', () => {
    const e = el({ scrollTop: 100 });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    animateScrollTop(e, 101, { reduced: false });
    expect(e.scrollTop).toBe(101);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('animates over frames and finishes exactly on target', () => {
    const e = el();
    let now = 1000;
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('requestAnimationFrame', (fn) => { rafs.push(fn); return rafs.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    animateScrollTop(e, 600, { reduced: false });
    expect(rafs.length).toBe(1);

    now = 1000 + SCROLL_MS / 2;
    rafs.shift()(now);
    expect(e.scrollTop).toBeGreaterThan(0);
    expect(e.scrollTop).toBeLessThan(600);

    now = 1000 + SCROLL_MS;
    rafs.shift()(now);
    expect(e.scrollTop).toBe(600);
    expect(rafs.length).toBe(0); // stopped, no trailing frames
  });

  it('cancels an in-flight tween when retargeted, so rapid hovers do not fight', () => {
    const e = el();
    const cancel = vi.fn();
    let now = 1000;
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('requestAnimationFrame', (fn) => { rafs.push(fn); return rafs.length; });
    vi.stubGlobal('cancelAnimationFrame', cancel);

    animateScrollTop(e, 600, { reduced: false });
    animateScrollTop(e, 900, { reduced: false });
    expect(cancel).toHaveBeenCalled();
  });

  it('is a no-op on a missing element rather than throwing', () => {
    expect(() => animateScrollTop(null, 100)).not.toThrow();
  });
});
