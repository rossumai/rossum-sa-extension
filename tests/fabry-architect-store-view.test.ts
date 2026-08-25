import { existsSync, readFileSync } from 'node:fs';

const srcUrl = (base: any) =>
  ['.ts', '.js']
    .map((ext) => new URL(`../src/${base}${ext}`, import.meta.url))
    .find((u) => existsSync(u))!;
import { describe, it, expect, vi } from 'vitest';
import {
  PREF_KEYS,
  DOC_VIEWS,
  migrateDocView,
  docView,
  railOpen,
  setRailOpen,
  railWidth,
  setRailWidth,
  settledTarget,
  setSettledTarget,
  RAIL_SETTLE_MS,
  clampRailWidth,
  RAIL_MIN,
  RAIL_MAX,
  spyTarget,
  pinnedTarget,
  setSpyTarget,
  setPinnedTarget,
  reviewTarget,
  setReviewTarget,
} from '../src/fabry/architect/store.js';

describe('document view modes', () => {
  it('offers exactly edit and preview — the combined mode is gone', () => {
    expect(DOC_VIEWS).toEqual(['edit', 'preview']);
  });

  it('migrates a stored split to preview, and keeps a known value', () => {
    expect(migrateDocView('split')).toBe('preview');
    expect(migrateDocView('edit')).toBe('edit');
    expect(migrateDocView('preview')).toBe('preview');
  });

  it('defaults anything unrecognised to preview — the mode Cmd+F works in', () => {
    expect(migrateDocView(undefined)).toBe('preview');
    expect(migrateDocView('nonsense')).toBe('preview');
    expect(migrateDocView(42)).toBe('preview');
  });

  it('starts in preview', () => {
    expect(docView.value).toBe('preview');
  });
});

describe('layout + targeting signals', () => {
  it('the inspector starts open and can be closed — the list has no such pref at all', () => {
    expect(railOpen.value).toBe(true);
    setRailOpen(false);
    expect(railOpen.value).toBe(false);
    setRailOpen(true);
  });

  it('the inspector width is clamped so it can neither vanish nor crowd out the document', () => {
    expect(railWidth.value).toBe(322);
    expect(clampRailWidth(10)).toBe(RAIL_MIN);
    expect(clampRailWidth(9999)).toBe(RAIL_MAX);
    expect(clampRailWidth(400.6)).toBe(401);
    expect(clampRailWidth('nonsense')).toBe(322);
    setRailWidth(500);
    expect(railWidth.value).toBe(500);
    setRailWidth(322);
  });

  it('tracks the scroll target and an explicit pin separately', () => {
    setSpyTarget('d2');
    expect(spyTarget.value).toBe('d2');
    setSpyTarget('d2'); // idempotent: no needless signal write
    expect(spyTarget.value).toBe('d2');
    setPinnedTarget('d1');
    expect(pinnedTarget.value).toBe('d1');
    setPinnedTarget(null);
    expect(pinnedTarget.value).toBe(null);
  });

  it('carries a request to show a diff at document width', () => {
    setReviewTarget({ id: 'd1', kind: 'history' });
    expect(reviewTarget.value).toEqual({ id: 'd1', kind: 'history' });
    setReviewTarget(null);
    expect(reviewTarget.value).toBe(null);
  });
});

describe('the inspector follows a SETTLED target', () => {
  // Measured: a 60-frame scroll produced 44 DOM mutations inside the rail — a panel nobody can read
  // mid-flight, re-rendering on nearly every frame. So scroll updates are debounced while explicit
  // clicks are not.
  it('debounces a scroll-driven change', async () => {
    vi.useFakeTimers();
    setSettledTarget('a', { immediate: true });
    setSettledTarget('b');
    expect(settledTarget.value).toBe('a');
    vi.advanceTimersByTime(RAIL_SETTLE_MS - 1);
    expect(settledTarget.value).toBe('a');
    vi.advanceTimersByTime(2);
    expect(settledTarget.value).toBe('b');
    vi.useRealTimers();
  });

  it('coalesces a burst into ONE change — the point of the exercise', () => {
    vi.useFakeTimers();
    setSettledTarget('a', { immediate: true });
    for (const id of ['b', 'c', 'd', 'e']) setSettledTarget(id);
    expect(settledTarget.value).toBe('a');
    vi.advanceTimersByTime(RAIL_SETTLE_MS + 1);
    expect(settledTarget.value).toBe('e'); // only the last one ever renders
    vi.useRealTimers();
  });

  it('never delays an explicit click', () => {
    setSettledTarget('a', { immediate: true });
    setSettledTarget('z', { immediate: true });
    expect(settledTarget.value).toBe('z');
  });

  it('lands immediately on the first target, so the rail is never blank at open', () => {
    settledTarget.value = null;
    setSettledTarget('first');
    expect(settledTarget.value).toBe('first');
  });
});

describe('persisted preferences', () => {
  // `chrome.storage.local.get([keys])` returns ONLY the requested keys, so a preference that is
  // written but not requested reads back as undefined for ever — which is how the inspector's width
  // was persisted and never restored (owner report, 2026-08-19). This asserts the two lists agree.
  it('requests every key the store writes', () => {
    const src = readFileSync(srcUrl('fabry/architect/store'), 'utf8');
    const written = new Set([
      ...[...src.matchAll(/local\?\.set\(\{\s*(fabryArch\w+)/g)].map((m) => m[1]),
      ...[...src.matchAll(/persistBool\('(fabryArch\w+)'/g)].map((m) => m[1]),
    ]);
    expect(written.size).toBeGreaterThan(2); // the scan actually found the writes
    for (const key of written) expect(PREF_KEYS).toContain(key);
  });

  it('does not carry the retired split ratio: nothing reads it, so reading it buys nothing', () => {
    // The combined mode is gone. A stored `fabryArchSplitRatio` is inert — left in place rather
    // than migrated, because an orphaned number costs a user nothing.
    expect(PREF_KEYS).not.toContain('fabryArchSplitRatio');
  });
});
