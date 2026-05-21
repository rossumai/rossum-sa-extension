import { describe, it, expect } from 'vitest';
import {
  applySortToPipeline,
  applyFilterDeltaToPipeline,
  applySkipToPipeline,
  extractUIStateFromPipeline,
  stripPaginationStages,
} from '../src/mdh/pipelineOps.js';

describe('applySortToPipeline', () => {
  it('replaces an existing $sort with the new spec', () => {
    const p = [{ $match: {} }, { $sort: { foo: 1 } }, { $skip: 0 }];
    applySortToPipeline(p, { bar: -1 });
    expect(p).toEqual([{ $match: {} }, { $sort: { bar: -1 } }, { $skip: 0 }]);
  });

  it('inserts $sort immediately after $match when absent', () => {
    const p = [{ $match: { x: 1 } }, { $skip: 0 }, { $limit: 50 }];
    applySortToPipeline(p, { foo: -1 });
    expect(p).toEqual([
      { $match: { x: 1 } },
      { $sort: { foo: -1 } },
      { $skip: 0 },
      { $limit: 50 },
    ]);
  });

  it('inserts $sort before $skip/$limit when no $match exists', () => {
    const p = [{ $skip: 0 }, { $limit: 50 }];
    applySortToPipeline(p, { foo: 1 });
    expect(p).toEqual([{ $sort: { foo: 1 } }, { $skip: 0 }, { $limit: 50 }]);
  });

  it('appends $sort when the pipeline is empty', () => {
    const p = [];
    applySortToPipeline(p, { foo: 1 });
    expect(p).toEqual([{ $sort: { foo: 1 } }]);
  });

  it('removes $sort when sortSpec is empty', () => {
    const p = [{ $match: {} }, { $sort: { foo: 1 } }, { $skip: 0 }];
    applySortToPipeline(p, {});
    expect(p).toEqual([{ $match: {} }, { $skip: 0 }]);
  });

  it('preserves user-written $match with placeholders when adding sort', () => {
    const p = [
      { $match: { 'id.erpAcct': 'LYNN', 'id.poId': '{order_id}', 'id.erpName': 'TRILOGIE' } },
      { $skip: 0 },
      { $limit: 50 },
    ];
    applySortToPipeline(p, { amount: -1 });
    expect(p).toEqual([
      { $match: { 'id.erpAcct': 'LYNN', 'id.poId': '{order_id}', 'id.erpName': 'TRILOGIE' } },
      { $sort: { amount: -1 } },
      { $skip: 0 },
      { $limit: 50 },
    ]);
  });

  it('places $sort after the last $match when multiple are present', () => {
    const p = [{ $match: { a: 1 } }, { $project: { x: 1 } }, { $match: { b: 2 } }, { $limit: 10 }];
    applySortToPipeline(p, { x: 1 });
    expect(p).toEqual([
      { $match: { a: 1 } },
      { $project: { x: 1 } },
      { $match: { b: 2 } },
      { $sort: { x: 1 } },
      { $limit: 10 },
    ]);
  });
});

describe('applyFilterDeltaToPipeline', () => {
  it('merges a new filter key into the existing $match', () => {
    const p = [{ $match: { existing: 'x' } }];
    applyFilterDeltaToPipeline(p, 'newKey', 'y', true);
    expect(p).toEqual([{ $match: { existing: 'x', newKey: 'y' } }]);
  });

  it('removes only the specified key from $match when deactivated', () => {
    const p = [{ $match: { keep: 'x', drop: 'y' } }];
    applyFilterDeltaToPipeline(p, 'drop', 'y', false);
    expect(p).toEqual([{ $match: { keep: 'x' } }]);
  });

  it('creates a new $match at the top when activating with no $match present', () => {
    const p = [{ $skip: 0 }, { $limit: 50 }];
    applyFilterDeltaToPipeline(p, 'foo', 'bar', true);
    expect(p).toEqual([{ $match: { foo: 'bar' } }, { $skip: 0 }, { $limit: 50 }]);
  });

  it('does nothing when deactivating a key that is not in $match', () => {
    const p = [{ $match: { a: 1 } }];
    applyFilterDeltaToPipeline(p, 'missing', 'x', false);
    expect(p).toEqual([{ $match: { a: 1 } }]);
  });
});

describe('applySkipToPipeline', () => {
  it('updates an existing $skip value', () => {
    const p = [{ $match: {} }, { $skip: 0 }, { $limit: 50 }];
    applySkipToPipeline(p, 100);
    expect(p).toEqual([{ $match: {} }, { $skip: 100 }, { $limit: 50 }]);
  });

  it('inserts $skip before $limit when absent', () => {
    const p = [{ $match: {} }, { $limit: 50 }];
    applySkipToPipeline(p, 25);
    expect(p).toEqual([{ $match: {} }, { $skip: 25 }, { $limit: 50 }]);
  });

  it('appends $skip when no $limit exists', () => {
    const p = [{ $match: {} }];
    applySkipToPipeline(p, 50);
    expect(p).toEqual([{ $match: {} }, { $skip: 50 }]);
  });
});

describe('extractUIStateFromPipeline', () => {
  it('returns empty state for a pipeline with neither $sort nor $match', () => {
    expect(extractUIStateFromPipeline([{ $limit: 10 }])).toEqual({ sorts: {}, filters: {} });
  });

  it('extracts multi-key $sort verbatim', () => {
    const p = [{ $sort: { name: 1, age: -1 } }];
    expect(extractUIStateFromPipeline(p)).toEqual({ sorts: { name: 1, age: -1 }, filters: {} });
  });

  it('ignores $sort entries with non ±1 values', () => {
    const p = [{ $sort: { name: 1, weird: 5 } }];
    expect(extractUIStateFromPipeline(p).sorts).toEqual({ name: 1 });
  });

  it('extracts primitive-valued $match entries into filters', () => {
    const p = [{ $match: { status: 'active', count: 5, flag: true, nothing: null } }];
    expect(extractUIStateFromPipeline(p).filters).toEqual({
      status: 'active', count: 5, flag: true, nothing: null,
    });
  });

  it('skips operator-valued $match entries (e.g., $gt)', () => {
    const p = [{ $match: { price: { $gt: 10 }, status: 'active' } }];
    expect(extractUIStateFromPipeline(p).filters).toEqual({ status: 'active' });
  });

  it('handles non-array input safely', () => {
    expect(extractUIStateFromPipeline(null)).toEqual({ sorts: {}, filters: {} });
    expect(extractUIStateFromPipeline({})).toEqual({ sorts: {}, filters: {} });
    expect(extractUIStateFromPipeline(undefined)).toEqual({ sorts: {}, filters: {} });
  });

  it('uses only the first $sort and the first $match when multiple exist', () => {
    const p = [
      { $match: { a: 1 } },
      { $sort: { x: 1 } },
      { $match: { b: 2 } },
      { $sort: { y: -1 } },
    ];
    const r = extractUIStateFromPipeline(p);
    expect(r.sorts).toEqual({ x: 1 });
    expect(r.filters).toEqual({ a: 1 });
  });

  it('recovers the bug-report scenario: manual $match survives as chips-equivalent filters', () => {
    const p = [
      { $match: { 'id.erpAcct': 'LYNN', 'id.poId': '{order_id}', 'id.erpName': 'TRILOGIE' } },
      { $sort: { amount: -1 } },
      { $skip: 0 },
      { $limit: 50 },
    ];
    expect(extractUIStateFromPipeline(p)).toEqual({
      sorts: { amount: -1 },
      filters: { 'id.erpAcct': 'LYNN', 'id.poId': '{order_id}', 'id.erpName': 'TRILOGIE' },
    });
  });
});

describe('stripPaginationStages', () => {
  it('removes the contiguous trailing run of $skip/$limit stages', () => {
    const p = [
      { $match: { x: 1 } },
      { $sort: { y: -1 } },
      { $skip: 100 },
      { $limit: 50 },
    ];
    expect(stripPaginationStages(p)).toEqual([
      { $match: { x: 1 } },
      { $sort: { y: -1 } },
    ]);
  });

  it('preserves mid-pipeline $skip/$limit when followed by a non-pagination stage', () => {
    // The mid-pipeline $limit:100 is a real semantic cap; the trailing
    // $skip+$limit are paginators and should go.
    const p = [
      { $match: { x: 1 } },
      { $limit: 100 },
      { $sort: { y: -1 } },
      { $skip: 0 },
      { $limit: 25 },
    ];
    expect(stripPaginationStages(p)).toEqual([
      { $match: { x: 1 } },
      { $limit: 100 },
      { $sort: { y: -1 } },
    ]);
  });

  it('preserves mid-pipeline $skip used as a query operation', () => {
    // $skip mid-pipeline is part of the query semantics (e.g., "skip the
    // top 50 then group the rest"). Don't touch it.
    const p = [
      { $match: {} },
      { $skip: 50 },
      { $group: { _id: '$cat', total: { $sum: 1 } } },
      { $limit: 10 },
    ];
    expect(stripPaginationStages(p)).toEqual([
      { $match: {} },
      { $skip: 50 },
      { $group: { _id: '$cat', total: { $sum: 1 } } },
    ]);
  });

  it('returns the pipeline unchanged when the last stage is not pagination', () => {
    // No trailing run to strip; the mid $skip/$limit pair are preserved.
    const p = [
      { $match: {} },
      { $sort: { y: 1 } },
      { $skip: 0 },
      { $limit: 25 },
      { $group: { _id: '$x' } },
    ];
    expect(stripPaginationStages(p)).toEqual(p);
  });

  it('preserves non-pagination stages including $project, $lookup, $group, $unwind', () => {
    const p = [
      { $match: {} },
      { $lookup: { from: 'a', localField: 'b', foreignField: 'c', as: 'd' } },
      { $unwind: '$d' },
      { $group: { _id: '$x', total: { $sum: 1 } } },
      { $project: { _id: 0, total: 1 } },
    ];
    expect(stripPaginationStages(p)).toEqual(p);
  });

  it('handles a pipeline with only pagination stages by returning an empty array', () => {
    expect(stripPaginationStages([{ $skip: 0 }, { $limit: 10 }])).toEqual([]);
  });

  it('strips a trailing run of more than one $limit or $skip', () => {
    // Hand-edited pipelines may have redundant trailing pagination stages.
    expect(stripPaginationStages([{ $match: {} }, { $skip: 0 }, { $skip: 5 }, { $limit: 10 }])).toEqual([{ $match: {} }]);
    expect(stripPaginationStages([{ $match: {} }, { $limit: 50 }, { $limit: 10 }])).toEqual([{ $match: {} }]);
  });

  it('returns an empty array unchanged', () => {
    expect(stripPaginationStages([])).toEqual([]);
  });

  it('returns a new array rather than mutating the input', () => {
    const p = [{ $match: {} }, { $limit: 10 }];
    const out = stripPaginationStages(p);
    expect(p).toEqual([{ $match: {} }, { $limit: 10 }]); // input untouched
    expect(out).not.toBe(p);
  });

  it('throws when given a non-array', () => {
    expect(() => stripPaginationStages(null)).toThrow();
    expect(() => stripPaginationStages({ $match: {} })).toThrow();
    expect(() => stripPaginationStages('not a pipeline')).toThrow();
  });
});
