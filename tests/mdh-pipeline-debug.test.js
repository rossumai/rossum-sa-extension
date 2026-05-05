// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h, render } from 'preact';

vi.mock('../src/mdh/api.js');

import * as api from '../src/mdh/api.js';
import PipelineDebug from '../src/mdh/components/PipelineDebug.jsx';
import { selectedCollection } from '../src/mdh/store.js';

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
});

describe('PipelineDebug', () => {
  it('sends one aggregation per stage (no $facet bundling)', async () => {
    const pipeline = [
      { $search: { index: 'default', text: { query: 'foo', path: 'name' } } },
      { $match: { active: true } },
      { $sort: { _id: 1 } },
    ];
    api.aggregate.mockResolvedValue({ result: [{ n: 7 }] });

    mount({ pipeline });
    await flush();

    expect(api.aggregate).toHaveBeenCalledTimes(3);
    const calls = api.aggregate.mock.calls;

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
    expect(calls).toHaveLength(2);
    // Both prefix runs must start with $search so Atlas accepts them.
    expect(calls[0][1][0]).toEqual(search);
    expect(calls[1][1][0]).toEqual(search);
    // Each should end with $count so we get a count back.
    for (const [, sent] of calls) {
      expect(sent[sent.length - 1]).toEqual({ $count: 'n' });
    }
  });

  it('renders per-stage counts when all requests succeed', async () => {
    const pipeline = [{ $match: {} }, { $limit: 50 }];
    api.aggregate
      .mockResolvedValueOnce({ result: [{ n: 1000 }] })
      .mockResolvedValueOnce({ result: [{ n: 50 }] });

    const root = mount({ pipeline });
    await flush();

    const counts = [...root.querySelectorAll('.pipeline-debug-count')]
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

    const times = [...root.querySelectorAll('.pipeline-debug-time')];
    expect(times).toHaveLength(2);
    for (const t of times) {
      expect(t.textContent).toMatch(/^\d+ms$/);
      // Tooltip must clearly mark the timing as cumulative, not per-stage.
      expect(t.getAttribute('title') || '').toMatch(/cumulative/i);
      expect(t.getAttribute('title') || '').toMatch(/not per-stage/i);
    }
  });

  it('renders timing on error rows too (request still took time)', async () => {
    const pipeline = [{ $match: {} }];
    api.aggregate.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const root = mount({ pipeline });
    await flush();

    const time = root.querySelector('.pipeline-debug-time');
    expect(time).not.toBeNull();
    expect(time.textContent).toMatch(/^\d+ms$/);
  });
});
