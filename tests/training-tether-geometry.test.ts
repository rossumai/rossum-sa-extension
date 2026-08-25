// tests/training-tether-geometry.test.js
// Pure geometry for src/training/tether.js — no DOM, plain rects only.
import { describe, it, expect } from 'vitest';
import { tetherGeometry, offscreenHint } from '../src/training/tether.js';

const viewport = { width: 1200, height: 800 };
// The quest card as it actually renders: fixed bottom:16/right:16, width 268.
const cardRect = { left: 916, top: 584, right: 1184, bottom: 784 };
// A target near the top-left of the page — on screen, clear of the card.
const visibleTarget = { left: 100, top: 50, right: 220, bottom: 80 };

describe('tetherGeometry', () => {
  it('returns a plausible beveled d and arrow for a visible, non-overlapping target', () => {
    const geo = tetherGeometry(cardRect, visibleTarget, viewport)!;
    expect(geo).toBeTruthy();
    expect(typeof geo.d).toBe('string');
    expect(geo.d.startsWith('M ')).toBe(true);
    // The MDH Stages shape: straight legs (L) joined by rounded bends (Q), and
    // NOT the single cubic bezier (C) this drew before.
    expect(geo.d).toContain(' L ');
    expect(geo.d).toContain(' Q ');
    expect(geo.d).not.toContain(' C ');
    expect(Number.isFinite(geo.arrow.x)).toBe(true);
    expect(Number.isFinite(geo.arrow.y)).toBe(true);
    expect(['left', 'up']).toContain(geo.arrow.dir);
  });

  // The legs must not cross when the card and target are close: a stub longer
  // than half the span would fold the path back through itself.
  it('keeps the path monotonic toward the target when the span is tiny', () => {
    const closeTarget = { left: 880, top: 660, right: 900, bottom: 680 };
    const geo = tetherGeometry(cardRect, closeTarget, viewport);
    expect(geo).toBeTruthy();
    const xs = [...geo!.d.matchAll(/-?\d+\.\d+/g)].map(Number).filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(cardRect.left + 0.05);
  });

  // A Rossum document row measures 4263px wide against a ~1200px viewport
  // (measured live). Anchoring to its true right edge/centre put the arrow at
  // x≈4271 — a well-formed path drawn entirely off screen, which reads as "this
  // step has no tether". Both ends must land inside the viewport.
  it('aims at the visible part of a target far wider than the viewport', () => {
    const wideRow = { left: 333, top: 344, right: 4263, bottom: 392 };
    const card = { left: 916, top: 553, right: 1184, bottom: 746 };
    const geo = tetherGeometry(card, wideRow, viewport)!;

    expect(geo).toBeTruthy();
    expect(geo.arrow.x).toBeLessThanOrEqual(viewport.width);
    expect(geo.arrow.y).toBeLessThanOrEqual(viewport.height);
    const coords = [...geo.d.matchAll(/-?\d+\.\d+/g)].map(Number);
    expect(Math.max(...coords.filter((_, i) => i % 2 === 0))).toBeLessThanOrEqual(viewport.width);
  });

  // The card sits INSIDE that row's horizontal span, so the centres claim a
  // large horizontal offset while the rects do not separate on x at all. Only
  // the vertical gap is real, so the tether must arrive from below.
  it('picks the axis that actually separates the rects, not the further centre', () => {
    const wideRow = { left: 333, top: 344, right: 4263, bottom: 392 };
    const card = { left: 916, top: 553, right: 1184, bottom: 746 };
    expect(tetherGeometry(card, wideRow, viewport)!.arrow.dir).toBe('up');
  });

  it('returns null when the target is off the viewport entirely (scrolled below)', () => {
    const belowViewport = { left: 100, top: 850, right: 220, bottom: 900 };
    expect(tetherGeometry(cardRect, belowViewport, viewport)).toBe(null);
  });

  it('returns null when the target is off the viewport entirely (scrolled above)', () => {
    const aboveViewport = { left: 100, top: -200, right: 220, bottom: -150 };
    expect(tetherGeometry(cardRect, aboveViewport, viewport)).toBe(null);
  });

  it('returns null when the target overlaps the card, even though it is on screen', () => {
    const underCard = { left: 950, top: 600, right: 1000, bottom: 650 };
    expect(tetherGeometry(cardRect, underCard, viewport)).toBe(null);
  });

  it('returns null for missing inputs rather than throwing', () => {
    expect(tetherGeometry(null, visibleTarget, viewport)).toBe(null);
    expect(tetherGeometry(cardRect, null, viewport)).toBe(null);
    expect(tetherGeometry(cardRect, visibleTarget, null)).toBe(null);
  });

  it('starts from the card edge facing the target and ends near the target, plus a gap', () => {
    // Target is far more to the left than above/below → the "left edge" branch.
    const farLeft = { left: 10, top: 560, right: 130, bottom: 590 };
    const geo = tetherGeometry(cardRect, farLeft, viewport)!;
    expect(geo.arrow.x).toBeGreaterThan(farLeft.right); // ends past the target's right edge
    expect(geo.arrow.x - farLeft.right).toBeLessThan(20); // by a small gap, not far into open space
    expect(geo.arrow.dir).toBe('left'); // and the head points AT the target
  });

  // The last leg must run along the arrowhead's own axis, or shaft and head read
  // as a corner rather than as one arrow — the rule stageLink.js's `shaftElbow`
  // follows. For a left-pointing head that means the final segment is horizontal.
  it('arrives along the arrowhead axis', () => {
    const farLeft = { left: 10, top: 560, right: 130, bottom: 590 };
    const geo = tetherGeometry(cardRect, farLeft, viewport)!;
    const nums = [...geo.d.matchAll(/-?\d+\.\d+/g)].map(Number);
    const endY = nums[nums.length - 1];
    const prevY = nums[nums.length - 3]; // y of the point before the final L
    expect(endY).toBeCloseTo(prevY, 5);
    expect(endY).toBeCloseTo(geo.arrow.y, 5);
  });
});

describe('offscreenHint', () => {
  it('returns null when the target is on screen', () => {
    expect(offscreenHint(visibleTarget, viewport)).toBe(null);
  });

  it('points down when the target is scrolled below the viewport', () => {
    const below = { left: 100, top: 850, right: 220, bottom: 900 };
    expect(offscreenHint(below, viewport)).toEqual({ direction: 'down' });
  });

  it('points up when the target is scrolled above the viewport', () => {
    const above = { left: 100, top: -200, right: 220, bottom: -150 };
    expect(offscreenHint(above, viewport)).toEqual({ direction: 'up' });
  });

  it('returns null for missing inputs rather than throwing', () => {
    expect(offscreenHint(null, viewport)).toBe(null);
    expect(offscreenHint(visibleTarget, null)).toBe(null);
  });
});
