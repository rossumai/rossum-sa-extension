// Pure layout/scale math for the Overview "Charts" panel (storage treemap +
// docs×avg-size scatter). No DOM, no Preact — everything here is a pure
// function so it can be unit-tested directly (see tests/mdh-overview-charts.test.js).
//
// Inputs are the same per-collection `rows` the OverviewPanel already builds:
//   { name, count, size, storageSize, avgObjSize, nindexes, totalIndexSize, error? }
// Treemap area encodes on-disk storage (storageSize); tile/dot color encodes
// index overhead (totalIndexSize / storageSize). The scatter is log–log.

export const TOP_N = 14;
export const SCALE_MODES = ['linear', 'sqrt', 'log'];

// Color scale stops for index overhead: data-heavy (blue) → teal → index-heavy
// (yellow). Kept in sync with the legend gradient in console.css (.oc-legend-bar).
const SCALE_STOPS: [Rgb, Rgb, Rgb] = [
  [66, 112, 219],  // #4270db blue (data-heavy)
  [25, 184, 154],  // #19b89a teal
  [245, 197, 24],  // #f5c518 yellow (index-heavy)
];

function lerp(a: number, b: number, t: number) { return Math.round(a + (b - a) * t); }
type Rgb = [number, number, number];

function lerp3(a: Rgb, b: Rgb, t: number): Rgb { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function toHex(c: number) { const s = c.toString(16); return s.length < 2 ? `0${s}` : s; }

// ratio (0..∞) → [r,g,b], clamped at 1.0 (100%+ index overhead = the top stop).
function overheadRgb(ratio: number): Rgb {
  const t = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const [lo, mid, hi] = SCALE_STOPS;
  return t < 0.5 ? lerp3(lo, mid, t / 0.5) : lerp3(mid, hi, (t - 0.5) / 0.5);
}

export function overheadColor(ratio: number): string {
  const c = overheadRgb(ratio);
  return `#${toHex(c[0])}${toHex(c[1])}${toHex(c[2])}`;
}

// WCAG relative luminance → pick readable tile text over a given overhead color
// (the yellow end is light and needs dark text; the blue end needs white).
function relLuminance([r, g, b]: Rgb): number {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function overheadTextColor(ratio: number): string {
  return relLuminance(overheadRgb(ratio)) > 0.45 ? '#10223a' : '#ffffff';
}

// totalIndexSize / storageSize, guarded. 0 when storage is absent/zero.
export function indexOverhead(row: any): number {
  const s = row && row.storageSize;
  if (!s || s <= 0) return 0;
  const i = typeof row.totalIndexSize === 'number' ? row.totalIndexSize : 0;
  return i / s;
}

// Area transform for the treemap. Linear is honest (area = share); sqrt/log
// compress so small collections stay visible when one collection dominates.
export function scaleArea(bytes: number, mode: string): number {
  const b = bytes > 0 ? bytes : 0;
  if (mode === 'sqrt') return Math.sqrt(b);
  if (mode === 'log') return b > 0 ? Math.log10(b + 1) : 0;
  return b;
}

// rows → treemap items: the top `topN` collections by storage, plus a single
// aggregated "Other (k)" item folding the long tail (or none if it fits).
export function treemapItems(rows: any[], topN = TOP_N): any[] {
  const valid = (rows || []).filter(
    (r: any) => r && !r.error && typeof r.storageSize === 'number' && r.storageSize > 0,
  );
  const sorted = valid.slice().sort((a: any, b: any) => b.storageSize - a.storageSize);
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  const items: any[] = head.map((r: any) => ({
    name: r.name,
    storageSize: r.storageSize,
    totalIndexSize: r.totalIndexSize,
    overhead: indexOverhead(r),
    isOther: false,
    row: r,
  }));
  if (tail.length) {
    const storageSize = tail.reduce((s: number, r: any) => s + r.storageSize, 0);
    const totalIndexSize = tail.reduce((s: number, r: any) => s + (r.totalIndexSize || 0), 0);
    items.push({
      name: `Other (${tail.length})`,
      storageSize,
      totalIndexSize,
      overhead: storageSize > 0 ? totalIndexSize / storageSize : 0,
      isOther: true,
      memberCount: tail.length,
    });
  }
  return items;
}

// Squarified treemap (Bruls, Huizing & van Wijk). `items` carry a numeric
// `value` (already area-scaled); returns each item augmented with {x,y,w,h}.
export function squarify(items: any[], width: number, height: number): any[] {
  const positive = (items || []).filter((it: any) => it.value > 0);
  if (positive.length === 0 || width <= 0 || height <= 0) return [];
  const total = positive.reduce((s: number, it: any) => s + it.value, 0);
  const scale = (width * height) / total;
  const vals = positive.map((it: any) => ({ it, a: it.value * scale }));

  let x = 0; let y = 0; let w = width; let h = height;
  const out: any[] = [];
  let row: any[] = [];

  const worst = (r: any[], side: number) => {
    let sum = 0; let mx = 0; let mn = Infinity;
    for (const o of r) { sum += o.a; if (o.a > mx) mx = o.a; if (o.a < mn) mn = o.a; }
    const s2 = sum * sum; const d2 = side * side;
    return Math.max((d2 * mx) / s2, s2 / (d2 * mn));
  };

  const layout = (r: any[]) => {
    let sum = 0;
    for (const o of r) sum += o.a;
    if (w >= h) {
      const sw = sum / h; let yy = y;
      for (const o of r) { const hh = o.a / sw; out.push({ ...o.it, x, y: yy, w: sw, h: hh }); yy += hh; }
      x += sw; w -= sw;
    } else {
      const sh = sum / w; let xx = x;
      for (const o of r) { const ww = o.a / sh; out.push({ ...o.it, x: xx, y, w: ww, h: sh }); xx += ww; }
      y += sh; h -= sh;
    }
  };

  for (const v of vals) {
    const side = Math.min(w, h);
    if (row.length === 0) { row.push(v); continue; }
    if (worst(row.concat([v]), side) <= worst(row, side)) row.push(v);
    else { layout(row); row = [v]; }
  }
  if (row.length) layout(row);
  return out;
}

// Full treemap: items → scaled value → squarified rects → color attached.
export function buildTreemap(
  rows: any[],
  { width, height, topN = TOP_N, mode = 'linear' }: { width: number; height: number; topN?: number; mode?: string } = {} as any,
) {
  const items = treemapItems(rows, topN).map((it: any) => ({ ...it, value: scaleArea(it.storageSize, mode) }));
  return squarify(items, width, height).map((t) => ({
    ...t,
    color: t.isOther ? null : overheadColor(t.overhead),
    textColor: t.isOther ? null : overheadTextColor(t.overhead),
  }));
}

// ~4 "nice" round tick values from 0..max, used for the linear/sqrt axes.
function niceLinearTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(v);
  return ticks;
}

// Axis scale for the scatter in the requested mode. Maps a value to a pixel
// position between pxLo (value-minimum end) and pxHi (value-maximum end); also
// returns tick marks {v, p}. mode is shared with the treemap area scale.
function axisScale(values: number[], mode: string, pxLo: number, pxHi: number) {
  const max = Math.max(...values);
  if (mode === 'log') {
    const min = Math.min(...values);
    let lo = Math.floor(Math.log10(min));
    let hi = Math.ceil(Math.log10(max));
    if (hi === lo) hi = lo + 1;
    const pos = (v: number) => pxLo + ((Math.log10(v) - lo) / (hi - lo)) * (pxHi - pxLo);
    const ticks = [];
    for (let k = lo; k <= hi; k++) ticks.push({ v: 10 ** k, p: pos(10 ** k) });
    return { pos, ticks };
  }
  const tf = mode === 'sqrt' ? Math.sqrt : (x: number) => x;
  const domMax = tf(max) || 1;
  const pos = (v: number) => pxLo + (tf(v) / domMax) * (pxHi - pxLo);
  const ticks = niceLinearTicks(max).map((v) => ({ v, p: pos(v) }));
  return { pos, ticks };
}

// Scatter layout: x = documents (count), y = avg doc size (avgObjSize), in the
// shared scale `mode` (linear / sqrt / log) so both charts move together.
// Returns positioned points, tick marks and plot geometry.
export function buildScatter(
  rows: any[],
  { width, height, mode = 'log' }: { width: number; height: number; mode?: string } = {} as any,
) {
  const M = { l: 40, r: 10, t: 8, b: 24 };
  const pw = Math.max(1, (width || 0) - M.l - M.r);
  const ph = Math.max(1, (height || 0) - M.t - M.b);
  const plot = { ...M, pw, ph, width: width || 0, height: height || 0 };

  const pts = (rows || []).filter((r: any) => r && !r.error && r.count > 0 && r.avgObjSize > 0);
  if (pts.length === 0 || !width || !height) return { points: [], xTicks: [], yTicks: [], plot };

  const xScale = axisScale(pts.map((r: any) => r.count), mode, M.l, M.l + pw);
  const yScale = axisScale(pts.map((r: any) => r.avgObjSize), mode, M.t + ph, M.t); // y grows upward

  const points = pts.map((r: any) => {
    const overhead = indexOverhead(r);
    return {
      name: r.name,
      cx: xScale.pos(r.count),
      cy: yScale.pos(r.avgObjSize),
      color: overheadColor(overhead),
      count: r.count,
      avgObjSize: r.avgObjSize,
      storageSize: r.storageSize,
      overhead,
    };
  });
  const xTicks = xScale.ticks.map((t) => ({ v: t.v, x: t.p }));
  const yTicks = yScale.ticks.map((t) => ({ v: t.v, y: t.p }));
  return { points, xTicks, yTicks, plot };
}
