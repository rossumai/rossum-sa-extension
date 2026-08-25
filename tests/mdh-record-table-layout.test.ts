import { describe, it, expect } from 'vitest';
import { computeColumnWidths, clampAutoFit } from '../src/mdh/recordTableLayout.js';

describe('computeColumnWidths', () => {
  it('fills exactly when columns fit (no gap)', () => {
    const w = computeColumnWidths({ availW: 1400, nonLastWidths: [400, 180, 180, 180, 180] });
    expect(w).toEqual([400, 180, 180, 180, 180, 280]);
    expect(w.reduce((a, b) => a + b, 0)).toBe(1400);
  });

  it('clamps last column to min and overflows when columns do not fit', () => {
    const w = computeColumnWidths({ availW: 700, nonLastWidths: [400, 180, 180, 180, 180] });
    expect(w[w.length - 1]).toBe(60);
    expect(w.reduce((a, b) => a + b, 0)).toBeGreaterThan(700);
  });

  it('accounts for the selection checkbox column', () => {
    const w = computeColumnWidths({
      availW: 1400,
      selectionW: 36,
      nonLastWidths: [400, 180, 180, 180, 180],
    });
    expect(w[w.length - 1]).toBe(244);
    expect(36 + w.reduce((a, b) => a + b, 0)).toBe(1400);
  });

  it('single column fills the pane', () => {
    expect(computeColumnWidths({ availW: 500, nonLastWidths: [] })).toEqual([500]);
    expect(computeColumnWidths({ availW: 500, selectionW: 36, nonLastWidths: [] })).toEqual([464]);
  });

  it('respects a custom min', () => {
    const w = computeColumnWidths({ availW: 100, nonLastWidths: [200], min: 80 });
    expect(w).toEqual([200, 80]);
  });
});

describe('clampAutoFit', () => {
  it('floors at min', () => {
    expect(clampAutoFit(30)).toBe(60);
  });
  it('caps at max', () => {
    expect(clampAutoFit(900)).toBe(600);
  });
  it('rounds within range', () => {
    expect(clampAutoFit(180.6)).toBe(181);
  });
  it('honors custom bounds', () => {
    expect(clampAutoFit(500, 100, 400)).toBe(400);
  });
});
