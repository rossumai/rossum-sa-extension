// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import PipelineDebug from '../src/mdh/components/PipelineDebug.jsx';
import { selectedCollection } from '../src/mdh/store.js';
// Wrap a plain stage array as all-enabled entries, the shape usePipeline hands the panel.
const stagesToEntries = (arr: any) =>
  Array.isArray(arr) ? arr.map((stage) => ({ disabled: false, stage })) : [];

// The 0th "input" row counts the whole collection via $collStats (instant
// metadata count) — distinct from the per-stage prefix runs, which end with
// $count. Helper to tell the two kinds of request apart in assertions.
const isInputCountCall = (call: any) => Boolean(call[1]?.[0]?.$collStats);
const isStageCountCall = (call: any) => {
  const pl = call[1];
  return Array.isArray(pl) && JSON.stringify(pl[pl.length - 1]) === JSON.stringify({ $count: 'n' });
};

let currentRoot: any = null;
function mount(props: any) {
  document.body.innerHTML = '';
  currentRoot = document.createElement('div');
  document.body.appendChild(currentRoot);
  const entries = props.entries ?? stagesToEntries(props.pipeline);
  render(
    <PipelineDebug
      entries={entries}
      onToggleStage={props.onToggleStage ?? (() => {})}
      onInspectStage={props.onInspectStage ?? (() => {})}
    />,
    currentRoot,
  );
  return currentRoot;
}

// Poll for the actual condition instead of guessing a fixed delay. PipelineDebug
// fans out aggregations from a useEffect (scheduled after paint), and clicking a
// row mounts StageInspector whose own effect fetches the preview — multi-hop
// async chains a fixed sleep races under full-suite CPU contention (the source
// of this file's intermittent failures).
async function waitFor(condition: any, description = 'condition', timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = condition();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const stageCountCells = (root: any) =>
  [
    ...root.querySelectorAll(
      '.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-count',
    ),
  ].map((el) => el.textContent);

// Unmount the previous tree before the next test clears mocks, so a prior test's
// deferred useStageCounts effect (scheduled after paint) cannot fire late and
// consume the next test's mockResolvedValueOnce values.
afterEach(() => {
  if (currentRoot) {
    render(null, currentRoot);
    currentRoot = null;
  }
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  selectedCollection.value = 'vendors';
});

describe('PipelineDebug', () => {
  it('sends one aggregation per stage plus one for the input count (no $facet bundling)', async () => {
    const pipeline = [
      { $search: { index: 'default', text: { query: 'foo', path: 'name' } } },
      { $match: { active: true } },
      { $sort: { _id: 1 } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 7 }] });

    mount({ pipeline });
    // 3 per-stage prefix runs + 1 input ($collStats) run are issued synchronously
    // once the mount effect runs.
    await waitFor(
      () => vi.mocked(api.aggregate).mock.calls.length >= 4,
      'all 4 prefix/input aggregations issued',
    );

    expect(api.aggregate).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(api.aggregate).mock.calls;
    expect(calls.filter(isStageCountCall)).toHaveLength(3);
    expect(calls.filter(isInputCountCall)).toHaveLength(1);

    // No call should wrap the pipeline in a top-level $facet.
    for (const [, sentPipeline] of calls) {
      expect(Array.isArray(sentPipeline)).toBe(true);
      const firstStage = sentPipeline[0];
      const firstKey = Object.keys(firstStage)[0];
      expect(firstKey).not.toBe('$facet');
    }
  });

  it('preserves $search as the first stage of every per-stage request', async () => {
    const search = { $search: { index: 'default', text: { query: 'foo', path: 'name' } } };
    const pipeline = [search, { $match: { x: 1 } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 1 }] });

    mount({ pipeline });
    // 2 per-stage prefix runs + 1 input run.
    await waitFor(
      () => vi.mocked(api.aggregate).mock.calls.length >= 3,
      'all 3 aggregations issued',
    );

    const calls = vi.mocked(api.aggregate).mock.calls;
    const stageCalls = calls.filter(isStageCountCall);
    expect(stageCalls).toHaveLength(2);
    // Both prefix runs must start with $search so Atlas accepts them, and end
    // with $count so we get a count back.
    for (const [, sent] of stageCalls) {
      expect(sent[0]).toEqual(search);
      expect(sent[sent.length - 1]).toEqual({ $count: 'n' });
    }
    // The input run counts ALL records via $collStats and is NOT prefixed with
    // $search (it represents the raw collection, independent of the pipeline).
    const inputCall = calls.find(isInputCountCall);
    expect(inputCall![1]).toEqual([{ $collStats: { count: {} } }, { $limit: 1 }]);
  });

  it('renders a 0th input row with the full collection count', async () => {
    const pipeline = [{ $match: { vendor: 'NOPE' } }];
    vi.mocked(api.aggregate).mockImplementation(
      (col, pl) =>
        pl[0]?.$collStats
          ? Promise.resolve({ result: [{ count: 4242 }] })
          : Promise.resolve({ result: [{ n: 0 }] }), // stage 1 matches nothing
    );

    const root = mount({ pipeline });
    // Wait for the input count to commit and the stage 1 count to leave its '…' state.
    await waitFor(
      () =>
        root.querySelector('.pipeline-debug-input-row')?.textContent.includes('4,242') &&
        stageCountCells(root)[0] &&
        !stageCountCells(root)[0].includes('…'),
      'input + stage counts rendered',
    );

    const inputRow = root.querySelector('.pipeline-debug-input-row');
    expect(inputRow).not.toBeNull();
    expect(inputRow.textContent).toContain('0.');
    expect(inputRow.textContent).toContain('4,242');
    // Stage 1 still shows its (zero) count below the input row.
    const stageCounts = stageCountCells(root);
    expect(stageCounts[0]).toContain('0');
  });

  it('clicking the 0th (input) row calls onInspectStage(-1)', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 0 }] });
    const inspected: any = [];
    const root = mount({
      pipeline: [{ $match: { vendor: 'NOPE' } }],
      onInspectStage: (i: any) => inspected.push(i),
    });
    await waitFor(() => root.querySelector('.pipeline-debug-input-row'), 'input row rendered');

    root.querySelector('.pipeline-debug-input-row').click();
    expect(inspected).toEqual([-1]);
  });

  it('clicking a stage row calls onInspectStage with its active index', async () => {
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 1 }] });
    const inspected: any = [];
    const root = mount({
      pipeline: [{ $match: {} }, { $sort: { _id: 1 } }],
      onInspectStage: (i: any) => inspected.push(i),
    });
    await waitFor(
      () =>
        root.querySelectorAll('.pipeline-debug-row:not(.pipeline-debug-input-row)').length === 2,
      'stage rows rendered',
    );

    root.querySelectorAll('.pipeline-debug-row:not(.pipeline-debug-input-row)')[1].click();
    expect(inspected).toEqual([1]);
  });

  it('renders per-stage counts when all requests succeed', async () => {
    const pipeline = [{ $match: {} }, { $limit: 50 }];
    vi.mocked(api.aggregate)
      .mockResolvedValue({ result: [] }) // default — covers the input ($collStats) run
      .mockResolvedValueOnce({ result: [{ n: 1000 }] })
      .mockResolvedValueOnce({ result: [{ n: 50 }] });

    const root = mount({ pipeline });
    await waitFor(() => {
      const c = stageCountCells(root);
      return c[0]?.includes('1,000') && c[1]?.includes('50');
    }, 'per-stage counts rendered');

    const counts = stageCountCells(root);
    expect(counts[0]).toContain('1,000');
    expect(counts[1]).toContain('50');
  });

  it('shows an inline error block for the failing stage with status + verbatim message', async () => {
    const pipeline = [
      { $search: { index: 'default', text: { query: 'foo', path: 'name' } } },
      { $match: { x: 1 } },
    ];
    const atlasErr = Object.assign(
      new Error('$search is not allowed to be used within a $facet stage'),
      { status: 400 },
    );
    vi.mocked(api.aggregate)
      .mockResolvedValue({ result: [] }) // default — covers the input run
      .mockRejectedValueOnce(atlasErr)
      .mockResolvedValueOnce({ result: [{ n: 42 }] });

    const root = mount({ pipeline });
    await waitFor(
      () =>
        root.textContent.includes('$search is not allowed to be used within a $facet stage') &&
        root.textContent.includes('42'),
      'error block + sibling count rendered',
    );

    // The verbatim upstream message must be visible in the panel,
    // not hidden behind a tooltip / devtools-only.
    expect(root.textContent).toContain('$search is not allowed to be used within a $facet stage');
    // Status should be surfaced too.
    expect(root.textContent).toMatch(/400/);
    // Non-failing stage still shows its count.
    expect(root.textContent).toContain('42');
  });

  it('treats one stage failing as independent of other stages', async () => {
    const pipeline = [{ $match: {} }, { $sort: { _id: 1 } }, { $limit: 10 }];
    vi.mocked(api.aggregate)
      .mockResolvedValue({ result: [] }) // default — covers the input run
      .mockResolvedValueOnce({ result: [{ n: 100 }] })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValueOnce({ result: [{ n: 10 }] });

    const root = mount({ pipeline });
    await waitFor(
      () =>
        root.textContent.includes('100') &&
        root.textContent.includes('10') &&
        root.textContent.includes('boom'),
      'both counts + error rendered',
    );

    expect(root.textContent).toContain('100');
    expect(root.textContent).toContain('10');
    expect(root.textContent).toContain('boom');
  });

  it('renders nothing when pipeline is empty or null', () => {
    const root1 = mount({ pipeline: null });
    expect(root1.querySelector('.pipeline-debug')).toBe(null);
    const root2 = mount({ pipeline: [] });
    expect(root2.querySelector('.pipeline-debug')).toBe(null);
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('renders cumulative wall-clock timing per stage on success', async () => {
    const pipeline = [{ $match: {} }, { $sort: { _id: 1 } }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 1 }] });

    const root = mount({ pipeline });
    await waitFor(
      () =>
        root.querySelectorAll(
          '.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-time',
        ).length === 2 && root.querySelector('.pipeline-debug-input-row .pipeline-debug-time'),
      'per-stage + input timing rendered',
    );

    // Per-stage timing is cumulative wall-clock; assert on the stage rows only.
    const times = [
      ...root.querySelectorAll(
        '.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-time',
      ),
    ];
    expect(times).toHaveLength(2);
    for (const t of times) {
      expect(t.textContent).toMatch(/^\d+ms$/);
      // Tooltip must clearly mark the timing as cumulative, not per-stage.
      expect(t.getAttribute('title') || '').toMatch(/cumulative/i);
      expect(t.getAttribute('title') || '').toMatch(/not per-stage/i);
    }

    // The 0th input row also shows its own ($collStats) timing.
    const inputTime = root.querySelector('.pipeline-debug-input-row .pipeline-debug-time');
    expect(inputTime).not.toBeNull();
    expect(inputTime.textContent).toMatch(/^\d+ms$/);

    // Fast (sub-second) timings must NOT be flagged slow.
    expect(root.querySelector('.pipeline-debug-time-slow')).toBeNull();
  });

  it('flags a stage timing as slow (orange) when its latency exceeds 1s', async () => {
    const pipeline = [{ $match: {} }];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 1 }] });

    // Force a measured latency well over the 1s threshold by advancing the clock
    // by 5s on every read (t0 vs. resolve → a multi-second delta), deterministically.
    const realNow = performance.now.bind(performance);
    let t = 0;
    performance.now = () => {
      t += 5000;
      return t;
    };
    try {
      const root = mount({ pipeline });
      await waitFor(
        () =>
          root.querySelector(
            '.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-time-slow',
          ),
        'a slow-flagged stage timing to render',
      );
      const slow = root.querySelector(
        '.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-time-slow',
      );
      expect(slow).not.toBeNull();
      // It is still the timing element, just additionally flagged.
      expect(slow.classList.contains('pipeline-debug-time')).toBe(true);
      expect(slow.textContent).toMatch(/^\d+ms$/);
    } finally {
      performance.now = realNow;
    }
  });

  it('renders timing on error rows too (request still took time)', async () => {
    const pipeline = [{ $match: {} }];
    vi.mocked(api.aggregate).mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const root = mount({ pipeline });
    await waitFor(
      () =>
        root.querySelector(
          '.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-time',
        ),
      'error-row timing rendered',
    );

    const time = root.querySelector(
      '.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-time',
    );
    expect(time).not.toBeNull();
    expect(time.textContent).toMatch(/^\d+ms$/);
  });
});

describe('PipelineDebug — write-stage safety', () => {
  it('never passes $out or $merge to api.aggregate even when they appear in entries', async () => {
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $out: 'archive' } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 3 }] });

    mount({ entries });
    // 2 active stage prefixes + 1 input ($collStats) run.
    await waitFor(() => vi.mocked(api.aggregate).mock.calls.length >= 3, 'all aggregations issued');

    for (const call of vi.mocked(api.aggregate).mock.calls) {
      const pipeline = call[1];
      if (!Array.isArray(pipeline)) continue;
      for (const stage of pipeline) {
        if (!stage || typeof stage !== 'object') continue;
        const key = Object.keys(stage)[0];
        expect(key).not.toBe('$out');
        expect(key).not.toBe('$merge');
      }
    }
  });

  it('never passes $merge to api.aggregate', async () => {
    const entries = [
      { disabled: false, stage: { $group: { _id: '$x' } } },
      { disabled: false, stage: { $merge: { into: 'targetCol' } } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 5 }] });

    mount({ entries });
    await waitFor(() => vi.mocked(api.aggregate).mock.calls.length >= 3, 'all aggregations issued');

    for (const call of vi.mocked(api.aggregate).mock.calls) {
      const pipeline = call[1];
      if (!Array.isArray(pipeline)) continue;
      for (const stage of pipeline) {
        if (!stage || typeof stage !== 'object') continue;
        const key = Object.keys(stage)[0];
        expect(key).not.toBe('$out');
        expect(key).not.toBe('$merge');
      }
    }
  });
});

describe('PipelineDebug — disabled stages', () => {
  it('renders a disabled row greyed, with no count request for it', async () => {
    const entries = [
      { disabled: false, stage: { $match: { x: 1 } } },
      { disabled: true, stage: { $sort: { a: -1 } } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 5 }] });

    const root = mount({ entries });
    // 2 active stage prefixes + 1 input ($collStats). The disabled stage adds none.
    await waitFor(
      () => vi.mocked(api.aggregate).mock.calls.length >= 3,
      'active prefixes + input issued',
    );

    const stageCalls = vi.mocked(api.aggregate).mock.calls.filter(isStageCountCall);
    expect(stageCalls).toHaveLength(2); // NOT 3 — disabled stage is not counted
    // No prefix request contains $sort (the disabled stage).
    for (const [, pl] of stageCalls) {
      expect(JSON.stringify(pl)).not.toContain('$sort');
    }
    expect(root.querySelector('.pipeline-debug-disabled')).not.toBeNull();
  });

  it('clicking a row toggle calls onToggleStage with the entry index', async () => {
    const entries = [
      { disabled: false, stage: { $match: {} } },
      { disabled: false, stage: { $limit: 50 } },
    ];
    vi.mocked(api.aggregate).mockResolvedValue({ result: [{ n: 1 }] });
    const calls: any = [];
    const root = mount({ entries, onToggleStage: (i: any) => calls.push(i) });
    await waitFor(
      () => root.querySelectorAll('.pipeline-stage-toggle').length === 2,
      'toggles rendered',
    );

    root.querySelectorAll('.pipeline-stage-toggle')[1].click();
    expect(calls).toEqual([1]);
  });
});
