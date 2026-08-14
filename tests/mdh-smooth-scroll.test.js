import { describe, it, expect, vi, afterEach } from 'vitest';
import { easeOutCubic, tweenAt, animateScrollTop, revealScrollTop, REVEAL_TOP_INSET, SCROLL_MS } from '../src/mdh/smoothScroll.js';

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

// The rule the owner set 2026-08-14: hovering a Stages-view section must NOT move
// the pipeline editor while the stage's opening line is already on screen — and
// when it does have to move, that line goes to the TOP of the box, not the middle
// (it centred until then, which is what made a visible stage travel on every
// hover). Everything below is in the scroller's scrollTop coordinate space.
describe('revealScrollTop', () => {
  const view = { scrollTop: 200, height: 400 }; // visible band: 200 → 600

  it('returns null — no scroll — while the opening line is fully in the band', () => {
    expect(revealScrollTop({ top: 300, bottom: 318 }, view)).toBeNull();
  });

  it('counts a line flush against either edge as visible', () => {
    expect(revealScrollTop({ top: 200, bottom: 218 }, view)).toBeNull();
    expect(revealScrollTop({ top: 582, bottom: 600 }, view)).toBeNull();
  });

  it('scrolls a line above the band to the top, less the inset', () => {
    expect(revealScrollTop({ top: 40, bottom: 58 }, view)).toBe(40 - REVEAL_TOP_INSET);
  });

  it('scrolls a line below the band to the top, not to the middle', () => {
    // Centring would have landed at 900 - (400 - 18) / 2 = 709.
    expect(revealScrollTop({ top: 900, bottom: 918 }, view)).toBe(900 - REVEAL_TOP_INSET);
  });

  it('scrolls a line only PARTLY cut off — half a line is not "on screen"', () => {
    expect(revealScrollTop({ top: 590, bottom: 608 }, view)).toBe(590 - REVEAL_TOP_INSET);
    expect(revealScrollTop({ top: 194, bottom: 212 }, view)).toBe(194 - REVEAL_TOP_INSET);
  });

  it('is idempotent: after a reveal the same hover asks for nothing', () => {
    const line = { top: 900, bottom: 918 };
    const to = revealScrollTop(line, view);
    // The line keeps its document position; the band moved to `to`.
    expect(revealScrollTop(line, { scrollTop: to, height: view.height })).toBeNull();
  });

  it('keeps the revealed line clear of the connector clamp', () => {
    // stageLink.js clamps the connector's editor endpoint EDGE_INSET (8px) inside
    // the clip box, and that endpoint is the line's vertical CENTRE. A line placed
    // flush at the top would sit half a line-height below the edge — inside 8px for
    // a small line height — and the connector would draw an off-screen arrow at a
    // stage that is right there. The inset is what buys that back, so it must not
    // silently become 0.
    const line = { top: 900, bottom: 906 }; // a deliberately short (6px) line
    const to = revealScrollTop(line, view);
    const centreFromTop = (line.top + line.bottom) / 2 - to;
    expect(centreFromTop).toBeGreaterThanOrEqual(8);
  });

  it('tolerates a degenerate band rather than throwing (jsdom has no layout)', () => {
    expect(revealScrollTop({ top: 0, bottom: 0 }, { scrollTop: 0, height: 0 })).toBeNull();
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
