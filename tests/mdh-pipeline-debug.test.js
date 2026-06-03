// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import PipelineDebug from '../src/mdh/components/PipelineDebug.jsx';
import Modal from '../src/mdh/components/Modal.jsx';
import { selectedCollection, modalContent } from '../src/mdh/store.js';

// The 0th "input" row counts the whole collection via $collStats (instant
// metadata count) — distinct from the per-stage prefix runs, which end with
// $count. Helper to tell the two kinds of request apart in assertions.
const isInputCountCall = (call) => Boolean(call[1]?.[0]?.$collStats);
const isStageCountCall = (call) => {
  const pl = call[1];
  return Array.isArray(pl) && JSON.stringify(pl[pl.length - 1]) === JSON.stringify({ $count: 'n' });
};

function mount(props) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(h(PipelineDebug, props), root);
  return root;
}

async function flush() {
  // First sleep > 0 lets Preact's effect queue drain (microtasks alone aren't
  // enough in jsdom); second tick lets resolved promises commit state back
  // into the rendered tree.
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectedCollection.value = 'vendors';
  modalContent.value = null;
});

describe('PipelineDebug', () => {
  it('sends one aggregation per stage plus one for the input count (no $facet bundling)', async () => {
    const pipeline = [
      { $search: { index: 'default', text: { query: 'foo', path: 'name' } } },
      { $match: { active: true } },
      { $sort: { _id: 1 } },
    ];
    api.aggregate.mockResolvedValue({ result: [{ n: 7 }] });

    mount({ pipeline });
    await flush();

    // 3 per-stage prefix runs + 1 input ($collStats) run.
    expect(api.aggregate).toHaveBeenCalledTimes(4);
    const calls = api.aggregate.mock.calls;
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
    api.aggregate.mockResolvedValue({ result: [{ n: 1 }] });

    mount({ pipeline });
    await flush();

    const calls = api.aggregate.mock.calls;
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
    expect(inputCall[1]).toEqual([{ $collStats: { count: {} } }, { $limit: 1 }]);
  });

  it('renders a 0th input row with the full collection count', async () => {
    const pipeline = [{ $match: { vendor: 'NOPE' } }];
    api.aggregate.mockImplementation((col, pl) =>
      pl[0]?.$collStats
        ? Promise.resolve({ result: [{ count: 4242 }] })
        : Promise.resolve({ result: [{ n: 0 }] }), // stage 1 matches nothing
    );

    const root = mount({ pipeline });
    await flush();

    const inputRow = root.querySelector('.pipeline-debug-input-row');
    expect(inputRow).not.toBeNull();
    expect(inputRow.textContent).toContain('0.');
    expect(inputRow.textContent).toContain('4,242');
    // Stage 1 still shows its (zero) count below the input row.
    const stageCounts = [...root.querySelectorAll('.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-count')]
      .map((el) => el.textContent);
    expect(stageCounts[0]).toContain('0');
  });

  it('clicking the 0th row previews the first raw documents (before any stage)', async () => {
    const pipeline = [{ $match: { vendor: 'NOPE' } }];
    api.aggregate.mockImplementation((col, pl) => {
      if (pl[0]?.$collStats) return Promise.resolve({ result: [{ count: 3 }] });
      if (JSON.stringify(pl) === JSON.stringify([{ $limit: 5 }])) {
        return Promise.resolve({ result: [{ _id: '1', vendor: 'ACME' }] });
      }
      return Promise.resolve({ result: [{ n: 0 }] });
    });

    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(h('div', null, h(PipelineDebug, { pipeline }), h(Modal, null)), root);
    await flush();

    root.querySelector('.pipeline-debug-input-row').click();
    await flush();

    // The inspector previews the raw collection: empty prefix + $limit, no $match.
    expect(api.aggregate.mock.calls.some(
      (c) => JSON.stringify(c[1]) === JSON.stringify([{ $limit: 5 }]),
    )).toBe(true);
    expect(document.body.textContent).toContain('ACME');
    expect(document.body.textContent).toMatch(/before any stage/i);
  });

  it('renders per-stage counts when all requests succeed', async () => {
    const pipeline = [{ $match: {} }, { $limit: 50 }];
    api.aggregate
      .mockResolvedValue({ result: [] }) // default — covers the input ($collStats) run
      .mockResolvedValueOnce({ result: [{ n: 1000 }] })
      .mockResolvedValueOnce({ result: [{ n: 50 }] });

    const root = mount({ pipeline });
    await flush();

    const counts = [...root.querySelectorAll('.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-count')]
      .map((el) => el.textContent);
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
    api.aggregate
      .mockResolvedValue({ result: [] }) // default — covers the input run
      .mockRejectedValueOnce(atlasErr)
      .mockResolvedValueOnce({ result: [{ n: 42 }] });

    const root = mount({ pipeline });
    await flush();

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
    api.aggregate
      .mockResolvedValue({ result: [] }) // default — covers the input run
      .mockResolvedValueOnce({ result: [{ n: 100 }] })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValueOnce({ result: [{ n: 10 }] });

    const root = mount({ pipeline });
    await flush();

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
    api.aggregate.mockResolvedValue({ result: [{ n: 1 }] });

    const root = mount({ pipeline });
    await flush();

    // Per-stage timing is cumulative wall-clock; assert on the stage rows only.
    const times = [...root.querySelectorAll('.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-time')];
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
  });

  it('renders timing on error rows too (request still took time)', async () => {
    const pipeline = [{ $match: {} }];
    api.aggregate.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const root = mount({ pipeline });
    await flush();

    const time = root.querySelector('.pipeline-debug-row:not(.pipeline-debug-input-row) .pipeline-debug-time');
    expect(time).not.toBeNull();
    expect(time.textContent).toMatch(/^\d+ms$/);
  });
});
