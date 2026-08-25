// tests/training-baseline.test.js
import { describe, it, expect } from 'vitest';
import {
  hookQueuePairs, fieldCount, ruleIds, thresholds, collectionCount,
  grew, changed, isIdsOnly,
} from '../src/training/baseline.js';

const HOOKS = { results: [
  { url: 'https://o.rossum.app/api/v1/hooks/7', queues: ['https://o.rossum.app/api/v1/queues/1'] },
  { url: 'https://o.rossum.app/api/v1/hooks/8', queues: [] },
] };

const QUEUES = { results: [
  { url: 'https://o.rossum.app/api/v1/queues/4', default_score_threshold: 0.8 },
  { url: 'https://o.rossum.app/api/v1/queues/12', default_score_threshold: 0.95 },
] };

describe('signature builders', () => {
  it('builds hook:queue pairs of numeric ids', () => {
    expect(hookQueuePairs(HOOKS)).toEqual(['7:1']);
  });

  it('counts schema fields across sections without recording their ids', () => {
    const schema = { content: [
      { category: 'section', children: [{ id: 'invoice_id' }, { id: 'total' }] },
      { category: 'section', children: [{ id: 'vendor' }] },
    ] };
    expect(fieldCount(schema)).toBe(3);
  });

  // Real nesting, verified live on elis 2026-08-07: a multivalue's `children`
  // is a single OBJECT (the tuple), whose `children` is the column array.
  const TABLE_SCHEMA = (columns: any) => ({ content: [
    { category: 'section', id: 'sec', children: [
      { category: 'datapoint', id: 'total' },
      { category: 'multivalue', id: 'line_items', children: {
        category: 'tuple', id: 'line_item', children: columns,
      } },
    ] },
  ] });

  it('counts fields nested inside a line-item table', () => {
    const schema = TABLE_SCHEMA([
      { category: 'datapoint', id: 'item_code' },
      { category: 'datapoint', id: 'item_qty' },
    ]);
    // 1 datapoint + multivalue + tuple + 2 columns = 5. The section is a
    // container, not a field.
    expect(fieldCount(schema)).toBe(5);
  });

  it('moves when a column is added inside a table — the delta the step relies on', () => {
    const before = fieldCount(TABLE_SCHEMA([{ category: 'datapoint', id: 'item_code' }]));
    const after = fieldCount(TABLE_SCHEMA([
      { category: 'datapoint', id: 'item_code' },
      { category: 'datapoint', id: 'item_qty' },
    ]));
    expect(grew(before, after)).toBe(true);
  });

  it('extracts rule ids and per-queue thresholds', () => {
    expect(ruleIds({ results: [{ id: 5 }, { id: 2 }] })).toEqual([2, 5]);
    expect(thresholds({ results: [
      { url: 'https://o.rossum.app/api/v1/queues/4', default_score_threshold: 0.8 },
    ] })).toEqual({ 4: 0.8 });
  });

  it('counts Data Storage collections from the REAL `result` key', () => {
    // The shape the live endpoint actually returns (singular `result`).
    // Getting this key wrong returns 0 forever and silently kills the step.
    expect(collectionCount({ result: ['vendors', 'gl_codes'] })).toBe(2);
    expect(collectionCount({ result: [] })).toBe(0);
  });

  it('tolerates the defensive fallback shapes', () => {
    expect(collectionCount({ collections: ['a'] })).toBe(1);
    expect(collectionCount({ results: [{}, {}, {}] })).toBe(3);
    expect(collectionCount({})).toBe(0);
  });
});

describe('delta predicates', () => {
  it('grew() is true only when a NEW member appears', () => {
    expect(grew([1, 2], [1, 2, 3])).toBe(true);
    expect(grew([1, 2], [1, 2])).toBe(false);
    expect(grew([1, 2], [1])).toBe(false);
    expect(grew(2, 3)).toBe(true);      // counts
    expect(grew(2, 2)).toBe(false);
  });

  it('changed() is true when any shared key changes value', () => {
    expect(changed({ 4: 0.8 }, { 4: 0.9 })).toBe(true);
    expect(changed({ 4: 0.8 }, { 4: 0.8 })).toBe(false);
    expect(changed({ 4: 0.8 }, { 4: 0.8, 5: 0.7 })).toBe(false); // a new queue is not a change
  });

  it('treats a missing baseline as "cannot have grown"', () => {
    expect(grew(null, [1])).toBe(false);
    expect(changed(null, { 4: 0.9 })).toBe(false);
  });
});

describe('isIdsOnly — the privacy guard', () => {
  it('accepts integers, id pairs and maps of them', () => {
    expect(isIdsOnly([1, 2, 3])).toBe(true);
    expect(isIdsOnly(['7:1'])).toBe(true);
    expect(isIdsOnly({ 4: 0.8 })).toBe(true);
    expect(isIdsOnly(7)).toBe(true);
  });

  it('rejects any org-authored string', () => {
    expect(isIdsOnly(['vendors'])).toBe(false);
    expect(isIdsOnly({ name: 'Acme queue' })).toBe(false);
    expect(isIdsOnly(['invoice_id'])).toBe(false);
  });

  // This is the ONLY test guarding the integers-only privacy invariant, and it
  // was feeding EMPTY inputs to most of the builders — isIdsOnly([]) and
  // isIdsOnly(0) are vacuously true, so a builder that leaked a schema id or a
  // collection name would have sailed straight through. Every input below is
  // populated with realistic org content, and `nonEmpty` fails the test if a
  // future change makes one of them empty again.
  it('every builder output is ids-only, on POPULATED org data', () => {
    const SCHEMAS = { content: [
      { category: 'section', id: 'basic_info', children: [
        { category: 'datapoint', id: 'invoice_id' }, { category: 'datapoint', id: 'vendor_name' }] },
    ] };
    const nonEmpty = (sig: any) => {
      if (Array.isArray(sig)) return sig.length > 0;
      if (typeof sig === 'number') return sig > 0;
      return Object.keys(sig).length > 0;
    };
    const outputs = {
      hookQueuePairs: hookQueuePairs(HOOKS),
      fieldCount: fieldCount(SCHEMAS),
      ruleIds: ruleIds({ results: [{ id: 5 }, { id: 2 }] }),
      thresholds: thresholds(QUEUES),
      collectionCount: collectionCount({ result: ['vendors', 'gl_codes'] }),
    };
    for (const [name, sig] of Object.entries(outputs)) {
      expect(nonEmpty(sig), `${name} produced an empty signature — the check below would be vacuous`).toBe(true);
      expect(isIdsOnly(sig), `${name} leaked something that is not an id`).toBe(true);
    }
    // The org-authored names fed in above must appear NOWHERE in the outputs.
    const serialized = JSON.stringify(outputs);
    for (const secret of ['invoice_id', 'vendor_name', 'basic_info', 'vendors', 'gl_codes']) {
      expect(serialized).not.toContain(secret);
    }
  });
});
