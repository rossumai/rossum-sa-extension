import { describe, it, expect } from 'vitest';
import {
  overheadColor, overheadTextColor, indexOverhead, scaleArea, treemapItems, squarify,
  buildTreemap, buildScatter, TOP_N, SCALE_MODES,
} from '../src/mdh/overviewCharts.js';

const MiB = 1024 * 1024;

describe('overheadColor', () => {
  it('maps the scale endpoints and midpoint to the legend colors (blue→teal→yellow)', () => {
    expect(overheadColor(0)).toBe('#4270db');   // data-heavy (blue)
    expect(overheadColor(0.5)).toBe('#19b89a');  // teal
    expect(overheadColor(1)).toBe('#f5c518');    // index-heavy (yellow)
  });
  it('clamps out-of-range and non-finite ratios', () => {
    expect(overheadColor(-3)).toBe('#4270db');
    expect(overheadColor(5)).toBe('#f5c518');
    expect(overheadColor(NaN)).toBe('#4270db');
    expect(overheadColor(undefined)).toBe('#4270db');
  });
});

describe('overheadTextColor', () => {
  it('uses white text on the dark blue end and dark text on the light yellow end', () => {
    expect(overheadTextColor(0)).toBe('#ffffff');   // over blue
    expect(overheadTextColor(1)).toBe('#10223a');   // over yellow
  });
});

describe('indexOverhead', () => {
  it('returns totalIndexSize / storageSize', () => {
    expect(indexOverhead({ storageSize: 100, totalIndexSize: 50 })).toBe(0.5);
  });
  it('guards zero/absent storage and absent index size', () => {
    expect(indexOverhead({ storageSize: 0, totalIndexSize: 50 })).toBe(0);
    expect(indexOverhead({ storageSize: 100 })).toBe(0);
    expect(indexOverhead({})).toBe(0);
  });
});

describe('scaleArea', () => {
  it('linear is identity, zero/negative collapse to 0', () => {
    expect(scaleArea(1000, 'linear')).toBe(1000);
    expect(scaleArea(0, 'linear')).toBe(0);
    expect(scaleArea(-5, 'linear')).toBe(0);
  });
  it('sqrt and log are monotonic and compress spread', () => {
    expect(scaleArea(100, 'sqrt')).toBe(10);
    // log keeps order but shrinks a 1000x gap to a small factor
    const lo = scaleArea(1024, 'log');
    const hi = scaleArea(1024 * 1000, 'log');
    expect(hi).toBeGreaterThan(lo);
    expect(hi / lo).toBeLessThan(3); // strongly compressed vs linear's 1000x
  });
  it('preserves ordering across all modes', () => {
    for (const m of SCALE_MODES) {
      expect(scaleArea(2 * MiB, m)).toBeGreaterThan(scaleArea(1 * MiB, m));
    }
  });
});

describe('treemapItems', () => {
  const rows = [
    { name: 'a', storageSize: 50 * MiB, totalIndexSize: 5 * MiB },
    { name: 'b', storageSize: 30 * MiB, totalIndexSize: 3 * MiB },
    { name: 'c', storageSize: 10 * MiB, totalIndexSize: 1 * MiB },
    { name: 'd', storageSize: 4 * MiB, totalIndexSize: 2 * MiB },
    { name: 'err', error: 'boom' },
    { name: 'empty', storageSize: 0 },
    { name: 'nostat' },
  ];

  it('excludes errored, zero-storage and unloaded rows', () => {
    const items = treemapItems(rows, 10);
    expect(items.map((i) => i.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('folds the tail into a single "Other (k)" item', () => {
    const items = treemapItems(rows, 2);
    expect(items.map((i) => i.name)).toEqual(['a', 'b', 'Other (2)']);
    const other = items[2];
    expect(other.isOther).toBe(true);
    expect(other.memberCount).toBe(2);
    expect(other.storageSize).toBe(14 * MiB); // c + d
    expect(other.totalIndexSize).toBe(3 * MiB);
    expect(other.overhead).toBeCloseTo((3 * MiB) / (14 * MiB), 6);
  });

  it('sorts by storage descending and adds no Other when the tail is empty', () => {
    const items = treemapItems(rows, 10);
    expect(items.some((i) => i.isOther)).toBe(false);
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].storageSize).toBeGreaterThanOrEqual(items[i].storageSize);
    }
  });
});

describe('squarify', () => {
  it('lays out one rect per positive item and conserves total area', () => {
    const items = [
      { name: 'a', value: 50 }, { name: 'b', value: 30 },
      { name: 'c', value: 15 }, { name: 'd', value: 5 },
    ];
    const W = 400; const H = 300;
    const rects = squarify(items, W, H);
    expect(rects).toHaveLength(4);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(W * H, 2);
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-6);
    }
  });
  it('areas are proportional to value', () => {
    const items = [{ name: 'big', value: 75 }, { name: 'small', value: 25 }];
    const rects = squarify(items, 200, 200);
    const byName = Object.fromEntries(rects.map((r) => [r.name, r.w * r.h]));
    expect(byName.big / byName.small).toBeCloseTo(3, 1);
  });
  it('returns [] for empty input or zero size', () => {
    expect(squarify([], 100, 100)).toEqual([]);
    expect(squarify([{ value: 10 }], 0, 100)).toEqual([]);
    expect(squarify([{ value: 0 }], 100, 100)).toEqual([]);
  });
});

describe('buildTreemap', () => {
  const rows = [
    { name: 'a', storageSize: 40 * MiB, totalIndexSize: 0 },
    { name: 'b', storageSize: 20 * MiB, totalIndexSize: 40 * MiB }, // 200% overhead → red
  ];
  it('colors data tiles and leaves Other uncolored', () => {
    const tiles = buildTreemap([...rows,
      { name: 'c', storageSize: 1 * MiB, totalIndexSize: 0 },
      { name: 'd', storageSize: 0.5 * MiB, totalIndexSize: 0 },
    ], { width: 300, height: 200, topN: 2, mode: 'linear' });
    const other = tiles.find((t) => t.isOther);
    expect(other.color).toBeNull();
    const b = tiles.find((t) => t.name === 'b');
    expect(b.color).toBe('#f5c518'); // 200% overhead clamps to the yellow end
    expect(b.textColor).toBe('#10223a'); // dark text over yellow
    const a = tiles.find((t) => t.name === 'a');
    expect(a.color).toBe('#4270db'); // zero overhead → blue
    expect(a.textColor).toBe('#ffffff'); // white text over blue
  });
});

describe('buildScatter', () => {
  const rows = [
    { name: 'a', count: 100, avgObjSize: 1024, storageSize: 5 * MiB, totalIndexSize: 1 * MiB },
    { name: 'b', count: 10000, avgObjSize: 4096, storageSize: 30 * MiB, totalIndexSize: 3 * MiB },
    { name: 'tiny', count: 0, avgObjSize: 0 },     // excluded
    { name: 'err', error: 'x', count: 5, avgObjSize: 100 }, // excluded
  ];
  it('plots only valid points within the plot area', () => {
    const r = buildScatter(rows, { width: 300, height: 200 });
    expect(r.points.map((p) => p.name).sort()).toEqual(['a', 'b']);
    for (const p of r.points) {
      expect(p.cx).toBeGreaterThanOrEqual(r.plot.l - 1e-6);
      expect(p.cx).toBeLessThanOrEqual(r.plot.l + r.plot.pw + 1e-6);
      expect(p.cy).toBeGreaterThanOrEqual(r.plot.t - 1e-6);
      expect(p.cy).toBeLessThanOrEqual(r.plot.t + r.plot.ph + 1e-6);
    }
  });
  it('emits decade ticks as powers of ten in log mode', () => {
    const r = buildScatter(rows, { width: 300, height: 200, mode: 'log' });
    for (const tk of r.xTicks) expect(Math.log10(tk.v) % 1).toBeCloseTo(0, 9);
    for (const tk of r.yTicks) expect(Math.log10(tk.v) % 1).toBeCloseTo(0, 9);
  });
  it('honors the shared scale mode (linear) with linear ticks from 0, points in-bounds', () => {
    const r = buildScatter(rows, { width: 300, height: 200, mode: 'linear' });
    expect(r.points.map((p) => p.name).sort()).toEqual(['a', 'b']);
    expect(r.xTicks[0].v).toBe(0); // linear ticks start at 0, not a decade
    for (const p of r.points) {
      expect(p.cx).toBeGreaterThanOrEqual(r.plot.l - 1e-6);
      expect(p.cx).toBeLessThanOrEqual(r.plot.l + r.plot.pw + 1e-6);
      expect(p.cy).toBeGreaterThanOrEqual(r.plot.t - 1e-6);
      expect(p.cy).toBeLessThanOrEqual(r.plot.t + r.plot.ph + 1e-6);
    }
  });
  it('returns empty layout when there is no data or no size', () => {
    expect(buildScatter([], { width: 300, height: 200 }).points).toEqual([]);
    expect(buildScatter(rows, { width: 0, height: 200 }).points).toEqual([]);
  });
});

describe('module constants', () => {
  it('exposes a sane TOP_N and the three scale modes', () => {
    expect(TOP_N).toBeGreaterThan(0);
    expect(SCALE_MODES).toEqual(['linear', 'sqrt', 'log']);
  });
});
