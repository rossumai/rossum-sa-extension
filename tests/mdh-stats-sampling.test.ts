import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  STATS_MODE_SAMPLE,
  STATS_MODE_EXACT,
  STATS_MODES,
  SAMPLE_BYTE_BUDGET,
  SAMPLE_MAX_CELLS,
  SAMPLE_MAX_ROWS,
  affordableRows,
  analysisPlan,
  statsModeLabel,
  buildSampleReadPipeline,
  STATS_CHECKS,
} from '../src/mdh/statsPipelines.js';
import { assembleSampledStats } from '../src/mdh/statsCompute.js';
import { statsMode, statsSummary, coerceStatsMode } from '../src/mdh/store.js';

vi.mock('../src/mdh/api.js', () => ({
  aggregate: vi.fn(),
  listIndexes: vi.fn(async () => ({ result: [] })),
  listSearchIndexes: vi.fn(async () => []),
}));

import { prefetchForPanel } from '../src/mdh/prefetch.js';
import * as api from '../src/mdh/api.js';
import * as cache from '../src/mdh/cache.js';

describe('analysisPlan', () => {
  // Neither budget may depend on `total`, so the grids below sweep the two
  // inputs that ARE allowed to matter: document size and field count.
  const AVG_SIZES = [200, 1024, 17_000, 250_000];
  const FIELD_COUNTS = [1, 5, 20, 50];

  it('never analyses fewer documents as the collection grows', () => {
    // This is the property the owner rejected the previous design over: a 90,000-doc
    // collection analysed 90,000 while a 110,000-doc one analysed ~5,000.
    for (const avgObjSize of AVG_SIZES) {
      for (const fieldCount of FIELD_COUNTS) {
        let previous = 0;
        for (const total of [
          0, 1, 500, 5_000, 50_000, 90_000, 110_000, 500_000, 5_000_000, 50_000_000,
        ]) {
          const { size } = analysisPlan(total, avgObjSize, fieldCount, STATS_MODE_SAMPLE);
          expect(size).toBeGreaterThanOrEqual(previous);
          expect(size).toBeLessThanOrEqual(total);
          previous = size;
        }
      }
    }
  });

  it('closes the case that sank the previous design', () => {
    const small = analysisPlan(90_000, 1024, 10, STATS_MODE_SAMPLE);
    const large = analysisPlan(110_000, 1024, 10, STATS_MODE_SAMPLE);
    expect(large.size).toBeGreaterThanOrEqual(small.size);
  });

  it('reads the whole collection when it fits the budget', () => {
    expect(analysisPlan(5_000, 1024, 10, STATS_MODE_SAMPLE)).toEqual({
      sampled: false,
      size: 5_000,
    });
  });

  it('samples what the budget affords once the collection exceeds it', () => {
    const rows = affordableRows(1024, 10);
    const plan = analysisPlan(5_000_000, 1024, 10, STATS_MODE_SAMPLE);
    expect(plan).toEqual({ sampled: true, size: rows });
  });

  it('draws fewer rows for wider documents, because the transfer cost is bytes', () => {
    expect(affordableRows(17_000, 10)).toBeLessThan(affordableRows(1024, 10));
  });

  it('draws fewer rows for a wider FIELD SET, because the client cost is cells', () => {
    // The byte budget's protection runs backwards for the client half: the
    // smaller the documents, the more rows fit, and the nine O(rows x fields)
    // profiling passes then block the main thread. Measured on V8, 65,536 rows
    // x 50 fields froze the Console for 12.3s.
    expect(affordableRows(200, 50)).toBeLessThan(affordableRows(200, 5));
  });

  it('keeps the sort buffer inside the byte budget for every document size', () => {
    // The guarantee that makes the >5% zone safe: rows * avgObjSize <= BUDGET.
    // SAMPLE_BYTE_BUDGET / 17_391 is the owner's rounded case (below), added
    // here so the invariant is checked against a ROUNDED row count too, not
    // only against sizes that happen to land on round numbers already.
    for (const avgObjSize of [...AVG_SIZES, 5_000_000, SAMPLE_BYTE_BUDGET / 17_391]) {
      for (const fieldCount of FIELD_COUNTS) {
        expect(affordableRows(avgObjSize, fieldCount) * avgObjSize).toBeLessThanOrEqual(
          SAMPLE_BYTE_BUDGET,
        );
      }
    }
  });

  it('rounds a realistic sample size down to a readable multiple of 1,000', () => {
    // The owner's live report: "a random sample of 17,391 of 1,280,909
    // documents". Derive avgObjSize from SAMPLE_BYTE_BUDGET rather than
    // hardcoding a byte size, so this test tracks the constant if it ever
    // moves: dividing the budget by the target row count and flooring the
    // division back through the same formula affordableRows uses lands on
    // 17,391 by construction, not by coincidence.
    const avgObjSize = SAMPLE_BYTE_BUDGET / 17_391;
    expect(Math.floor(SAMPLE_BYTE_BUDGET / avgObjSize)).toBe(17_391);
    expect(affordableRows(avgObjSize, 1)).toBe(17_000);
  });

  it('never rounds up', () => {
    for (const avgObjSize of AVG_SIZES) {
      for (const fieldCount of FIELD_COUNTS) {
        const unrounded = Math.floor(SAMPLE_BYTE_BUDGET / avgObjSize);
        expect(affordableRows(avgObjSize, fieldCount)).toBeLessThanOrEqual(unrounded);
      }
    }
  });

  it('leaves a sample below 1,000 exact, rather than flooring it to zero', () => {
    // A document size large enough that only a few hundred rows fit the byte
    // budget must not be rounded down to a multiple of 1,000 -- that would
    // floor it to zero.
    const avgObjSize = 5_000_000;
    const unrounded = Math.floor(SAMPLE_BYTE_BUDGET / avgObjSize);
    expect(unrounded).toBeGreaterThan(0);
    expect(unrounded).toBeLessThan(1_000);
    expect(affordableRows(avgObjSize, 1)).toBe(unrounded);
  });

  it('still rounds when the cell ceiling, not the byte budget, is binding', () => {
    // At 50 fields the ceiling gives 400,000 / 50 = 8,000, already a multiple
    // of 1,000, so that case alone would pass even with no rounding at all.
    // 21 fields does not: 400,000 / 21 floors to 19,047 unrounded.
    expect(affordableRows(1, 50)).toBe(8_000);
    expect(Math.floor(SAMPLE_MAX_CELLS / 21)).toBe(19_047);
    expect(affordableRows(1, 21)).toBe(19_000);
  });

  it('keeps the profiling work inside the cell ceiling for every field count', () => {
    // The guarantee that bounds main-thread time: rows * fields <= CELLS.
    for (const avgObjSize of [1, ...AVG_SIZES]) {
      for (const fieldCount of FIELD_COUNTS) {
        expect(affordableRows(avgObjSize, fieldCount) * fieldCount).toBeLessThanOrEqual(
          SAMPLE_MAX_CELLS,
        );
      }
    }
  });

  it('clamps to the row ceiling when both budgets are wide open', () => {
    // One narrow field in a one-byte document leaves neither budget binding, so
    // this clamp is the only thing left bounding the read. It is load-bearing,
    // which is why it is asserted rather than merely exported.
    expect(affordableRows(1, 1)).toBe(SAMPLE_MAX_ROWS);
  });

  it('reads exactly when the document size is unknown', () => {
    // Without avgObjSize neither the transfer nor the $sample sort buffer can be
    // bounded, so a fixed row fallback would leave rows * avgObjSize unbounded.
    // We cannot bound a read we cannot size, so we do not sample it.
    expect(analysisPlan(50_000_000, 0, 10, STATS_MODE_SAMPLE)).toEqual({
      sampled: false,
      size: 50_000_000,
    });
  });

  it('never samples in Exact mode, at any size', () => {
    expect(analysisPlan(50_000_000, 1024, 10, STATS_MODE_EXACT)).toEqual({
      sampled: false,
      size: 50_000_000,
    });
  });
});

describe('buildSampleReadPipeline', () => {
  it('samples first, then projects the analysed fields plus the top-level key names', () => {
    const p = buildSampleReadPipeline(['a', 'b.c'], 5000);
    expect(p[0]).toEqual({ $sample: { size: 5000 } });
    expect(p[1].$project.a).toBe(1);
    expect(p[1].$project['b.c']).toBe(1);
    expect(p[1].$project._id).toBe(0);
    // `_topKeys` is what lets the schema-shape check survive the projection:
    // the key NAMES travel, the values stay on the server.
    expect(p[1].$project._topKeys).toEqual({
      $map: { input: { $objectToArray: '$$ROOT' }, as: 'k', in: '$$k.k' },
    });
    expect(p).toHaveLength(2);
  });

  it('$sample is the first stage, which is what keeps the random cursor available', () => {
    expect(Object.keys(buildSampleReadPipeline(['a'], 1000)[0])).toEqual(['$sample']);
  });
});

describe('statsModeLabel', () => {
  it('labels the two modes the way the control renders them', () => {
    expect(STATS_MODES).toEqual([STATS_MODE_SAMPLE, STATS_MODE_EXACT]);
    expect(statsModeLabel(STATS_MODE_SAMPLE)).toBe('Sample');
    expect(statsModeLabel(STATS_MODE_EXACT)).toBe('Exact');
  });
});

describe('statsMode preference', () => {
  it('defaults to Sample', () => {
    expect(statsMode.value).toBe(STATS_MODE_SAMPLE);
  });

  it('accepts both offered modes', () => {
    for (const m of STATS_MODES) expect(coerceStatsMode(m)).toBe(m);
  });

  it('falls back to Sample for a stale or hand-edited value', () => {
    // A value outside the mode list would otherwise reach analysisPlan directly.
    expect(coerceStatsMode('fast')).toBe(STATS_MODE_SAMPLE);
    expect(coerceStatsMode(5000)).toBe(STATS_MODE_SAMPLE);
    expect(coerceStatsMode(null)).toBe(STATS_MODE_SAMPLE);
    expect(coerceStatsMode(undefined)).toBe(STATS_MODE_SAMPLE);
  });
});

function analysisReads(size: number) {
  return vi
    .mocked(api.aggregate)
    .mock.calls.map((c) => c[1])
    .filter((p) => p[0].$sample && p[0].$sample.size === size);
}

// Everything a completed sampled run leaves behind, including the marker that
// records which run size produced it.
function seedSampledCache(collection: string, size: number, avgObjSize = 1024) {
  const fields = ['supplier'];
  const computed = assembleSampledStats(
    [{ supplier: 'ACME', _topKeys: ['_id', 'supplier'] }],
    fields,
    {
      result: [{ storageStats: { avgObjSize } }],
    },
  );
  cache.set(collection, 'statsFields', fields);
  cache.set(collection, 'totalCount', 4_000_000);
  cache.set(collection, 'stats_sampled', computed);
  for (const key of STATS_CHECKS) cache.set(collection, `stats_${key}`, computed[key]);
  cache.set(collection, 'statsRunSize', size);
}

describe('prefetchStats', () => {
  // 4,000,000 documents at this avgObjSize sit well past the byte budget, so
  // every test below lands on the SAME derived sample size — the number the
  // brief calls out explicitly rather than inventing a clean-looking constant.
  const AVG_OBJ_SIZE = 1024;
  // The mocked discovery document yields two leaf paths, `_topKeys` and
  // `supplier`, and the derived size has to be computed from the same field
  // count the code sees — the cell ceiling is part of it now.
  const FIELD_COUNT = 2;
  const SIZE = affordableRows(AVG_OBJ_SIZE, FIELD_COUNT); // 65536 unrounded, 65000 after rounding

  beforeEach(() => {
    cache.invalidateAll();
    statsMode.value = STATS_MODE_SAMPLE;
    vi.mocked(api.aggregate).mockReset();
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{ storageStats: { avgObjSize: AVG_OBJ_SIZE } }] };
    });
  });

  it('uses the sampled read above the budget, not the twelve check pipelines', async () => {
    await prefetchForPanel('example', 'stats');
    const sent = vi.mocked(api.aggregate).mock.calls.map((c) => c[1]);
    expect(sent.some((p) => p.some((st: any) => st.$facet))).toBe(false);
    expect(sent.filter((p) => p[0].$sample).map((p) => p[0].$sample.size)).toContain(SIZE);
  });

  it('does the work once when the panel and the prefetch race for it', async () => {
    // Both check the cache, both miss, and before this fix both fired the whole
    // suite — the concurrency the 2026-06 probe identified as the timeout cause.
    await Promise.all([prefetchForPanel('example', 'stats'), prefetchForPanel('example', 'stats')]);
    expect(analysisReads(SIZE)).toHaveLength(1);
  });

  it('re-runs when the cached entries were produced at a different run size', async () => {
    // Every collection caches for ten minutes independently, so a run can find
    // entries ANOTHER collection's run left behind at a different size. Reusing
    // them would divide by a sample size the payload never had.
    cache.set('example', 'statsFields', ['supplier']);
    cache.set('example', 'totalCount', 4_000_000);
    cache.set('example', 'stats_sampled', { coverage: { result: [] } });
    cache.set('example', 'statsRunSize', 1000);

    await prefetchForPanel('example', 'stats');

    expect(analysisReads(SIZE)).toHaveLength(1);
    expect(cache.get('example', 'statsRunSize')).toBe(SIZE);
  });

  it('republishes the tab-bar summary even when every entry is already cached', async () => {
    // The cache-hit path used to return before updateStatsSummary, so the dot
    // kept whichever collection was profiled last and never came back for this
    // one until the Stats panel was opened.
    seedSampledCache('example', SIZE, AVG_OBJ_SIZE);
    statsSummary.value = null;

    await prefetchForPanel('example', 'stats');

    expect(api.aggregate).not.toHaveBeenCalled();
    expect(statsSummary.value?.collection).toBe('example');
  });

  it('does not re-stamp a storage entry that came from the cache', async () => {
    // cache.set restamps, so writing a HIT back on every prefetch could keep a
    // repeatedly-visited collection's storage figures alive past TTL_LONG
    // indefinitely — and components/OverviewPanel.tsx reads the same key.
    cache.set('example', 'statsFields', ['supplier']);
    cache.set('example', 'totalCount', 4_000_000);
    cache.set('example', 'stats_storage', {
      result: [{ storageStats: { avgObjSize: AVG_OBJ_SIZE } }],
    });
    const setSpy = vi.spyOn(cache, 'set');

    await prefetchForPanel('example', 'stats');

    expect(setSpy.mock.calls.filter((c) => c[1] === 'stats_storage')).toEqual([]);
    setSpy.mockRestore();
  });

  it('still publishes the tab-bar summary when the storage probe fails', async () => {
    // The storage read returned on failure, so prefetchStats never reached
    // updateStatsSummary and the dot silently stopped appearing for this
    // collection — for a probe that only chooses between two paths. Without
    // avgObjSize the run reads exactly and carries on.
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline) => {
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.storageStats) throw new Error('storage stats unavailable');
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      // The coverage pipeline is the one updateStatsSummary cannot do without.
      if (pipeline[1]?.$group?._total) {
        return {
          result: [{ _total: 10, f_supplier: 10, f__topKeys: 10 }],
        };
      }
      return { result: [{}] };
    });
    statsSummary.value = null;

    await prefetchForPanel('example', 'stats');

    expect(statsSummary.value?.collection).toBe('example');
    // And it did not sample a read it could not size.
    const sent = vi.mocked(api.aggregate).mock.calls.map((c) => c[1]);
    expect(sent.some((p) => p.some((st: any) => st.$facet))).toBe(true);
    expect(sent.some((p) => p[0].$sample && p[0].$sample.size !== 200)).toBe(false);
  });

  it('a background abort does not cancel the read another caller joined', async () => {
    // The shared promise is handed to both callers, so a signal inside it makes
    // the joiner downstream of a cancellation it does not own — and the panel's
    // twelve checks all render "The user aborted a request."
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(api.aggregate).mockImplementation(async (_c, pipeline, opts?: any) => {
      if (pipeline[0].$sample?.size === SIZE) {
        await Promise.race([
          gate,
          new Promise((_ok, fail) => {
            opts?.signal?.addEventListener('abort', () =>
              fail(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })),
            );
          }),
        ]);
        return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      }
      if (pipeline[0].$sample) return { result: [{ supplier: 'ACME', _topKeys: ['_id'] }] };
      if (pipeline[0].$collStats?.count) return { result: [{ count: 4_000_000 }] };
      return { result: [{ storageStats: { avgObjSize: AVG_OBJ_SIZE } }] };
    });

    const bg = new AbortController();
    const background = prefetchForPanel('example', 'stats', { signal: bg.signal });
    await vi.waitFor(() => expect(analysisReads(SIZE)).toHaveLength(1));
    const joiner = prefetchForPanel('example', 'stats');
    // Fields, the count and the storage probe are all cached by now, so the
    // joiner is a couple of MICROTASKS from cache.single — no timer, and
    // nothing here is timing-based. If the flush were short the joiner would
    // issue its own read and the call count below would say so rather than
    // passing quietly.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    bg.abort();
    release();
    await Promise.all([background, joiner]);

    expect(analysisReads(SIZE)).toHaveLength(1);
    expect(cache.get('example', 'stats_sampled')).not.toBeNull();
  });
});
