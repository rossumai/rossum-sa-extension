// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js', () => ({
  aggregate: vi.fn(),
  listIndexes: vi.fn(async () => ({ result: [] })),
}));

import StatsPanel from '../src/mdh/components/StatsPanel.jsx';
import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';
import { selectedCollection, activePanel, statsMode } from '../src/mdh/store.js';
import {
  STATS_MODE_SAMPLE,
  STATS_MODE_EXACT,
  STATS_CHECKS,
  buildStoragePipeline,
  affordableRows,
} from '../src/mdh/statsPipelines.js';
import { assembleSampledStats } from '../src/mdh/statsCompute.js';
import { prefetchForPanel } from '../src/mdh/prefetch.js';

function pipelinesSent() {
  return vi.mocked(api.aggregate).mock.calls.map((c) => c[1]);
}

// Every mounted root is unmounted in the top-level afterEach below. Left
// mounted, a StatsPanel instance keeps reacting to the module-level signals
// (selectedCollection/activePanel/statsMode) it read during render, so a
// later test's signal write wakes a PRIOR test's "zombie" instance and it
// fires its own aggregate calls — invisible to assertions that only check
// shape, but fatal to one that counts exact calls, like the race test below.
const mountedRoots: HTMLElement[] = [];

function mount() {
  const root = document.createElement('div');
  mountedRoots.push(root);
  render(<StatsPanel />, root);
  return root;
}

afterEach(() => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop()!;
    render(null, root);
  }
});

// A fixed flush races preact's after-paint effects under full-suite load, so
// wait on the condition instead: the run is done once the storage read lands.
// vi.waitFor only retries on a THROW, which is what expect() gives us.
function settle(minCalls = 3) {
  return vi.waitFor(() =>
    expect(vi.mocked(api.aggregate).mock.calls.length).toBeGreaterThanOrEqual(minCalls),
  );
}

describe('StatsPanel path selection', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsMode.value = STATS_MODE_SAMPLE;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
  });

  it('issues one sampled read instead of the twelve check pipelines above the budget', async () => {
    // The mocked discovery document yields two leaf paths, `supplier` and
    // `_topKeys`, and the derived size is bounded by the field count as well as
    // by the document size — so it has to be computed from the same two inputs.
    const size = affordableRows(1024, 2);
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return {
        result: [{ storageStats: { size: 1, storageSize: 2, avgObjSize: 1024, count: 4 } }],
      };
    });
    mount();
    await settle();
    const samples = pipelinesSent().filter((p) => p[0].$sample);
    // one 200-doc discovery sample, one <size>-doc analysis sample
    expect(samples.map((p) => p[0].$sample.size).sort((a, b) => a - b)).toEqual(
      [200, size].sort((a, b) => a - b),
    );
    expect(pipelinesSent().some((p) => p[0].$facet || p[1]?.$facet)).toBe(false);
    expect(pipelinesSent()).toContainEqual(buildStoragePipeline());
  });

  it('runs the exact pipelines below the budget', async () => {
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.count) return { result: [{ count: 900 }] };
      return { result: [{}] };
    });
    mount();
    await settle();
    expect(pipelinesSent().some((p) => p.some((st) => st.$facet))).toBe(true);
  });

  it('runs the exact pipelines on the Exact setting whatever the size', async () => {
    statsMode.value = STATS_MODE_EXACT;
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.count) return { result: [{ count: 40_000_000 }] };
      return { result: [{}] };
    });
    mount();
    await settle();
    expect(pipelinesSent().some((p) => p.some((st) => st.$facet))).toBe(true);
  });
});

describe('the analysis-mode control', () => {
  // Two leaf paths in the mocked discovery document: `supplier` and `_topKeys`.
  const AVG_OBJ_SIZE = 1024;
  const FIELD_COUNT = 2;
  const SAMPLE_SIZE = affordableRows(AVG_OBJ_SIZE, FIELD_COUNT);
  const LARGE_TOTAL = SAMPLE_SIZE * 5; // comfortably above the budget
  const SMALL_TOTAL = Math.min(10, SAMPLE_SIZE); // fits the budget in full

  function mockCollection(total: number) {
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.count) return { result: [{ count: total }] };
      return { result: [{ storageStats: { avgObjSize: AVG_OBJ_SIZE } }] };
    });
  }

  beforeEach(() => {
    cache.invalidateAll();
    statsMode.value = STATS_MODE_SAMPLE;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
    mockCollection(LARGE_TOTAL);
  });

  it('offers both modes and marks the stored mode active on a large collection', async () => {
    const root = mount();
    await settle();
    const opts = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')] as HTMLButtonElement[];
    expect(opts.map((o) => o.textContent)).toEqual(['Sample', 'Exact']);
    expect(opts.find((o) => o.getAttribute('aria-pressed') === 'true')!.textContent).toBe('Sample');
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it('writes the signal and re-runs when a different mode is chosen', async () => {
    const root = mount();
    await settle();
    const opts = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')];
    (opts.find((o) => o.textContent === 'Exact') as HTMLButtonElement).click();
    expect(statsMode.value).toBe(STATS_MODE_EXACT);
  });

  it('leaves the cache alone when the ACTIVE mode is clicked again', async () => {
    // The signal dedupes an identical write, so the effect never re-runs — and
    // an unconditional invalidate would leave the panel rendering its old
    // state against an empty cache.
    const root = mount();
    await settle();
    const opts = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')];
    (opts.find((o) => o.textContent === 'Sample') as HTMLButtonElement).click();
    expect(cache.get('example', 'statsFields')).not.toBeNull();
    expect(cache.get('example', 'totalCount')).not.toBeNull();
  });

  it('shows Exact active and Sample disabled on a small collection, without rewriting the stored mode', async () => {
    mockCollection(SMALL_TOTAL);
    const root = mount();
    await settle();
    const opts = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')] as HTMLButtonElement[];
    const sampleBtn = opts.find((o) => o.textContent === 'Sample')!;
    const exactBtn = opts.find((o) => o.textContent === 'Exact')!;
    expect(exactBtn.getAttribute('aria-pressed')).toBe('true');
    expect(sampleBtn.getAttribute('aria-pressed')).toBe('false');
    expect(sampleBtn.disabled).toBe(true);
    expect(sampleBtn.title).toBe('This collection is small enough to read in full');
    // The point of this test: the preference itself must survive untouched,
    // so a later, larger collection resumes sampling without the user having
    // to set it again.
    expect(statsMode.value).toBe(STATS_MODE_SAMPLE);
  });

  it('titles the disabled Sample segment for an unknown document size, not "small enough"', async () => {
    // avgObjSize is missing (storage probe failed), not merely small: a
    // multi-million-document collection must not be told it is "small enough
    // to read in full" when the real reason Sample is disabled is that
    // analysisPlan could not size a sampled read at all.
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.storageStats) throw new Error('storage stats unavailable');
      if (pipeline[0].$collStats?.count) return { result: [{ count: LARGE_TOTAL }] };
      return { result: [{}] };
    });
    const root = mount();
    await settle();
    await vi.waitFor(() =>
      expect(pipelinesSent().some((p) => p.some((st) => st.$facet))).toBe(true),
    );
    const sampleBtn = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')].find(
      (o) => o.textContent === 'Sample',
    ) as HTMLButtonElement;
    expect(sampleBtn.disabled).toBe(true);
    expect(sampleBtn.title).toBe(
      "Sampling needs the collection's average document size, which could not be read",
    );
  });

  it('does not fire the handler when the disabled Sample button is clicked', async () => {
    mockCollection(SMALL_TOTAL);
    const root = mount();
    await settle();
    const invalidateSpy = vi.spyOn(cache, 'invalidateData');
    const sampleBtn = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')].find(
      (o) => o.textContent === 'Sample',
    ) as HTMLButtonElement;
    expect(sampleBtn.disabled).toBe(true);
    sampleBtn.click();
    expect(statsMode.value).toBe(STATS_MODE_SAMPLE);
    expect(invalidateSpy).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it('leaves Exact active and Sample enabled when Exact is chosen explicitly on a large collection', async () => {
    statsMode.value = STATS_MODE_EXACT;
    const root = mount();
    await settle();
    const opts = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')] as HTMLButtonElement[];
    const sampleBtn = opts.find((o) => o.textContent === 'Sample')!;
    const exactBtn = opts.find((o) => o.textContent === 'Exact')!;
    expect(exactBtn.getAttribute('aria-pressed')).toBe('true');
    expect(sampleBtn.disabled).toBe(false);
  });

  it('resumes sampling after moving from a small collection to a large one, without the user touching the control', async () => {
    mockCollection(SMALL_TOTAL);
    const root = mount();
    await settle();
    let opts = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')] as HTMLButtonElement[];
    expect(opts.find((o) => o.getAttribute('aria-pressed') === 'true')!.textContent).toBe('Exact');

    vi.mocked(api.aggregate).mockReset();
    mockCollection(LARGE_TOTAL);
    selectedCollection.value = 'other-example';
    await settle();

    opts = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')] as HTMLButtonElement[];
    const sampleBtn = opts.find((o) => o.textContent === 'Sample')!;
    expect(sampleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(sampleBtn.disabled).toBe(false);
    expect(statsMode.value).toBe(STATS_MODE_SAMPLE);
  });

  it('shows the stored mode with neither segment disabled while the first run is still discovering fields', async () => {
    // canSample defaults to true and no plan exists yet during discovery, so
    // the control must not flash a disabled Sample segment and then
    // un-disable it once the plan lands. Gate the field-discovery sample
    // (pipeline length 1) so this assertion runs strictly before it resolves.
    let releaseDiscovery: () => void;
    const gate = new Promise<void>((r) => {
      releaseDiscovery = r;
    });
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample && pipeline.length === 1) {
        await gate;
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.count) return { result: [{ count: LARGE_TOTAL }] };
      return { result: [{ storageStats: { avgObjSize: AVG_OBJ_SIZE } }] };
    });
    const root = mount();
    // The discovery call has fired but not yet resolved: condition-based,
    // not a fixed timeout.
    await vi.waitFor(() =>
      expect(vi.mocked(api.aggregate).mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    const opts = [...root.querySelectorAll('.stats-mode-seg .view-seg-opt')] as HTMLButtonElement[];
    expect(opts).toHaveLength(2);
    expect(opts.every((o) => !o.disabled)).toBe(true);
    expect(opts.find((o) => o.getAttribute('aria-pressed') === 'true')!.textContent).toBe('Sample');
    releaseDiscovery!();
    await settle();
  });
});

describe('the sampled read is shared with a racing background prefetch', () => {
  let releaseGate: () => void;
  let gate: Promise<void>;
  const AVG_OBJ_SIZE = 1024;
  // Two leaf paths in the mocked discovery document: `supplier` and `_topKeys`.
  const SIZE = affordableRows(AVG_OBJ_SIZE, 2);

  beforeEach(() => {
    cache.invalidateAll();
    statsMode.value = STATS_MODE_SAMPLE;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
    gate = new Promise((r) => {
      releaseGate = r;
    });
    // The analysis sample (size SIZE) is the call cache.single is meant to
    // share, so it alone is held open on `gate` until the test releases it.
    // That removes any dependence on exact scheduling to expose a broken
    // guard: prefetchForPanel starts synchronously while the panel's effect
    // is deferred to after paint, so with instantly-resolving mocks
    // prefetchForPanel would finish its whole chain before the panel's effect
    // gets a turn, and a second (buggy) call would never happen to fire in
    // the window this test can see. Field discovery (size 200), the total
    // count check and the storage probe all resolve immediately — each
    // caller runs its own copy of those, which this fix does not dedupe:
    // avgObjSize now decides the path, so it is fetched before the decision
    // rather than inside the shared closure with the sample read.
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample?.size === SIZE) {
        await gate;
        return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      }
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.storageStats) {
        return { result: [{ storageStats: { avgObjSize: AVG_OBJ_SIZE } }] };
      }
      return { result: [{ count: 4_000_000 }] };
    });
  });

  it('issues exactly one analysis read when the panel and prefetchForPanel race on the same collection', async () => {
    // Both callers call THROUGH to cache.single itself no matter what it does
    // internally — only the WORK inside it is deduped, not the call. So this
    // spy proves both callers reached the shared guard, independent of
    // whether the guard's dedup is actually working; the assertion below is
    // what tests that separately.
    const singleSpy = vi.spyOn(cache, 'single');
    const root = mount();
    const prefetchDone = prefetchForPanel('example', 'stats');
    // Waiting on this rather than the clock is what stops the test passing
    // when the panel is merely slow under load: a starved run never reaches
    // two calls, so it fails instead of silently asserting nothing. vi.waitFor
    // only retries on a THROW, which expect() gives us.
    await vi.waitFor(() => expect(singleSpy).toHaveBeenCalledTimes(2));
    const analysisReads = pipelinesSent().filter((p) => p[0].$sample && p[0].$sample.size === SIZE);
    expect(analysisReads).toHaveLength(1);
    // Release and let both callers' continuations (cache.set, setRaw,
    // setStatus) flush before the next test's cache.invalidateAll, rather
    // than leaving them pending against an unmounted panel.
    releaseGate();
    await prefetchDone;
    await vi.waitFor(() => expect(root.querySelector('.stats-progress')).toBeNull());
    singleSpy.mockRestore();
  });
});

describe('a cached payload is distrusted unless it was produced at this size', () => {
  // Invalidation on a control change is per collection, so entries another
  // collection's run left behind at a DIFFERENT size outlive it for the ten
  // minutes of TTL_LONG. `statsRunSize` is what makes them recognisable.
  function seedSampledCache(size: number, avgObjSize = 1024) {
    const fields = ['supplier'];
    const computed = assembleSampledStats(
      [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }],
      fields,
      { result: [{ storageStats: { avgObjSize } }] },
    );
    cache.set('example', 'statsFields', fields);
    cache.set('example', 'statsFieldsTotal', 1);
    cache.set('example', 'totalCount', 4_000_000);
    cache.set('example', 'stats_sampled', computed);
    for (const key of STATS_CHECKS) cache.set('example', `stats_${key}`, computed[key]);
    cache.set('example', 'statsRunSize', size);
  }

  beforeEach(() => {
    cache.invalidateAll();
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{ storageStats: { avgObjSize: 1024 } }] };
    });
  });

  it('re-reads at the newly derived size instead of relabelling a stale payload', async () => {
    // The cache holds a run that claims size 1000, but the collection's own
    // totalCount and storage stats (avgObjSize 1024) are seeded consistently —
    // a fresh computation derives affordableRows(1024), which does not match
    // the stale marker, so the run must re-read rather than relabel it.
    // seedSampledCache seeds a single discovered field, so that is what the
    // fresh derivation sees too.
    const size = affordableRows(1024, 1);
    statsMode.value = STATS_MODE_SAMPLE;
    seedSampledCache(1000, 1024);
    mount();
    await settle(1);
    const sizes = pipelinesSent()
      .filter((p) => p[0].$sample)
      .map((p) => p[0].$sample.size);
    expect(sizes).toContain(size);
  });

  it('runs the exact pipelines on Exact rather than reusing the sampled entries', async () => {
    seedSampledCache(5000);
    statsMode.value = STATS_MODE_EXACT;
    mount();
    await settle(3);
    expect(pipelinesSent().some((p) => p.some((st) => st.$facet))).toBe(true);
    expect(cache.get('example', 'stats_sampled')).toBeNull();
  });
});

describe('a failed storage probe costs the sampled path and nothing else', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsMode.value = STATS_MODE_SAMPLE;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.storageStats) throw new Error('storage stats unavailable');
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{}] };
    });
  });

  it('keeps the exact document count and still renders the summary', async () => {
    // The count and the storage probe shared one Promise.all inside one try, and
    // Promise.all rejects on the first rejection — so a storage failure left the
    // block before setOverview and took a count that was ALREADY IN HAND with it.
    // totalDocs stayed 0, the summary and the schema disappeared entirely, and
    // every field reported 0% diversity because `analyzed` was 0 too.
    const root = mount();
    await settle();
    await vi.waitFor(() =>
      expect(root.querySelector('.stats-overview-card .stats-metric-value')).not.toBeNull(),
    );
    expect(cache.get('example', 'totalCount')).toBe(4_000_000);
    expect(root.querySelector('.stats-overview-card .stats-metric-value')!.textContent).toBe(
      (4_000_000).toLocaleString(),
    );
  });

  it('reads exactly rather than sampling a read it cannot size', async () => {
    // Without avgObjSize neither the transfer nor the $sample sort buffer can be
    // bounded, so the run degrades to the server pipelines instead of guessing.
    mount();
    await settle();
    await vi.waitFor(() =>
      expect(pipelinesSent().some((p) => p.some((st) => st.$facet))).toBe(true),
    );
    expect(pipelinesSent().some((p) => p[0].$sample && p[0].$sample.size !== 200)).toBe(false);
  });

  it('does not write a storage entry it could not read', async () => {
    mount();
    await settle();
    await vi.waitFor(() =>
      expect(pipelinesSent().some((p) => p.some((st) => st.$facet))).toBe(true),
    );
    expect(cache.get('example', 'stats_storage')).toBeNull();
  });
});

describe('a failed count aggregate falls back to the storage probe', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsMode.value = STATS_MODE_EXACT;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.count) throw new Error('count unavailable');
      return { result: [{ storageStats: { avgObjSize: 1024, count: 4_000_000 } }] };
    });
  });

  it('uses storageStats.count instead of leaving totalDocs at 0', async () => {
    // A failing count read used to zero totalDocs even though the storage
    // probe (fetched independently) already carries the same count — the
    // summary/schema then vanished and analysisPlan(0, …) ran the exact path
    // regardless of the real collection size. storageStats.count is the same
    // field OverviewPanel already reads as its count source.
    const root = mount();
    await settle();
    await vi.waitFor(() =>
      expect(root.querySelector('.stats-overview-card .stats-metric-value')).not.toBeNull(),
    );
    expect(cache.get('example', 'totalCount')).toBe(4_000_000);
    expect(root.querySelector('.stats-overview-card .stats-metric-value')!.textContent).toBe(
      (4_000_000).toLocaleString(),
    );
  });
});

describe('a failed sampled read clears the planned sample size', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsMode.value = STATS_MODE_SAMPLE;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      // The analysis sample carries a $project as its second stage; the
      // 200-doc field-discovery sample does not, so this is the only one
      // that fails.
      if (pipeline[0].$sample && pipeline.length > 1) throw new Error('sample read failed');
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{ storageStats: { avgObjSize: 1024, count: 4_000_000 } }] };
    });
  });

  it('does not claim a sample that never arrived', async () => {
    // sampledSize is set to the PLANNED size before the read even starts, so
    // the catch must clear it back to null — otherwise the info strip reads
    // "Estimated from a random sample of N of M documents" beside storage and
    // docSize figures that are exact $collStats metadata, not estimates.
    const root = mount();
    await settle(4);
    await vi.waitFor(() =>
      expect(root.querySelector('.stats-overview-card .stats-metric-value')).not.toBeNull(),
    );
    expect(root.querySelector('.stats-note')).toBeNull();
  });
});

describe('a cached storage entry is not re-stamped', () => {
  it('leaves the entry alone when the probe was a cache hit', async () => {
    // cache.set restamps, so writing a HIT back on every visit could keep a
    // repeatedly-visited collection's storage figures alive past TTL_LONG
    // indefinitely — and components/OverviewPanel.tsx reads the same key.
    cache.invalidateAll();
    statsMode.value = STATS_MODE_SAMPLE;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{ storageStats: { avgObjSize: 1024 } }] };
    });
    cache.set('example', 'stats_storage', { result: [{ storageStats: { avgObjSize: 1024 } }] });
    const setSpy = vi.spyOn(cache, 'set');
    mount();
    await settle(2);
    await vi.waitFor(() => expect(cache.get('example', 'stats_sampled')).not.toBeNull());
    expect(setSpy.mock.calls.filter((c) => c[1] === 'stats_storage')).toEqual([]);
    setSpy.mockRestore();
  });
});

describe('the sampled run reports what actually arrived', () => {
  beforeEach(() => {
    cache.invalidateAll();
    statsMode.value = STATS_MODE_SAMPLE;
    selectedCollection.value = 'example';
    activePanel.value = 'stats';
    vi.mocked(api.aggregate).mockReset();
  });

  it('labels the strip with the delivered sample, not the requested one', async () => {
    // $sample can return fewer rows than it was asked for, and computeCoverage
    // records what ARRIVED as `_total`. Reporting plan.size instead claimed a
    // sample that never came, and made diversityPct divide by a different
    // number than transformCoverage's own pct — from the same payload.
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample?.size === 200) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$sample) {
        // One document delivered against a request for tens of thousands.
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{ storageStats: { avgObjSize: 1024, size: 4, storageSize: 8 } }] };
    });
    const root = mount();
    await settle();
    await vi.waitFor(() => expect(root.querySelector('.stats-note')).not.toBeNull());
    expect(root.querySelector('.stats-note')!.textContent).toContain('sample of 1 of');
  });

  it('keeps storage and docSize when the sampled read fails', async () => {
    // Both were fetched in phase 1.5 from $collStats and are in hand, so a
    // failed sample does not invalidate them — marking them errored reported
    // two failures that did not happen and hid two figures that are exact.
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample?.size === 200) {
        return { result: [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }] };
      }
      if (pipeline[0].$sample) throw new Error('sample read failed');
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return {
        result: [
          {
            storageStats: {
              avgObjSize: 1024,
              size: 4_096_000,
              storageSize: 8_192_000,
              freeStorageSize: 0,
              count: 4_000_000,
            },
          },
        ],
      };
    });
    const root = mount();
    await settle();
    await vi.waitFor(() => {
      const labels = [...root.querySelectorAll('.stats-metric-label')].map((n) => n.textContent);
      expect(labels).toContain('On disk');
      expect(labels).toContain('Avg doc');
    });
  });
});
