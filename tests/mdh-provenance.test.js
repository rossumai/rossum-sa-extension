import { describe, it, expect } from 'vitest';
import {
  collectPlaceholders,
  describeQuery,
  flattenContent,
  substitutePlaceholders,
} from '../src/popup/mdh-provenance.js';

// ── describeQuery ─────────────────────────────────────

describe('describeQuery', () => {
  it('prefers q.name over comment, //, and the synthesized label', () => {
    const q = {
      name: 'PO by order number',
      comment: 'Stage 1',
      '//': 'old-style comment',
      aggregate: [{ $match: {} }],
    };
    expect(describeQuery(q)).toBe('PO by order number');
  });

  it('uses q.comment when q.name is absent (the MDH docs convention)', () => {
    const q = {
      comment: 'Stage 1: Exact VAT match',
      '//': 'should be ignored',
      aggregate: [{ $match: {} }],
    };
    expect(describeQuery(q)).toBe('Stage 1: Exact VAT match');
  });

  it('uses q["//"] when neither name nor comment is set', () => {
    const q = { '//': 'JSON-comment-style label', aggregate: [{ $match: {} }] };
    expect(describeQuery(q)).toBe('JSON-comment-style label');
  });

  it('skips empty/whitespace name and tries the next key', () => {
    const q = { name: '   ', comment: 'real comment', aggregate: [{ $match: {} }] };
    expect(describeQuery(q)).toBe('real comment');
  });

  it('falls back to the synthesized aggregate stage list when no label is present', () => {
    const q = { aggregate: [{ $match: {} }, { $sort: {} }, { $lookup: {} }] };
    expect(describeQuery(q)).toBe('aggregate: $match → $sort → $lookup');
  });

  it('falls back to find: <keys> for find-style queries', () => {
    expect(describeQuery({ find: { vendor_id: '{x}', country: 'US' } }))
      .toBe('find: vendor_id, country');
  });

  it('handles empty find / aggregate / unknown shapes', () => {
    expect(describeQuery({ find: {} })).toBe('find: (empty)');
    expect(describeQuery({ aggregate: [] })).toBe('aggregate: (empty)');
    expect(describeQuery({})).toBe('(unknown query type)');
  });

  it('ignores non-string label fields', () => {
    const q = { name: 42, comment: ['a'], aggregate: [{ $match: {} }] };
    expect(describeQuery(q)).toBe('aggregate: $match');
  });
});

// ── collectPlaceholders ───────────────────────────────

describe('collectPlaceholders', () => {
  it('collects bare placeholders from strings, arrays, and objects', () => {
    const set = new Set();
    collectPlaceholders({ x: '{a}', y: ['{b}', '{c}'], z: { w: '{a}' } }, set);
    expect([...set].sort()).toEqual(['a', 'b', 'c']);
  });

  it('collects the schema_id name from placeholders that carry modifiers', () => {
    const set = new Set();
    collectPlaceholders(
      { a: "{order_id | split(',')}", b: '{name | re}', c: '{ amount }' },
      set,
    );
    expect([...set].sort()).toEqual(['amount', 'name', 'order_id']);
  });

  it('ignores secrets.* placeholders (out of popup scope)', () => {
    const set = new Set();
    collectPlaceholders({ x: '{secrets.api_key}' }, set);
    expect([...set]).toEqual([]);
  });
});

// ── substitutePlaceholders — basic ────────────────────

describe('substitutePlaceholders — basic', () => {
  it('replaces a bare placeholder as a string by default', () => {
    expect(substitutePlaceholders({ x: '{a}' }, { a: 'hello' })).toEqual({ x: 'hello' });
  });

  it('returns empty string for a missing key', () => {
    expect(substitutePlaceholders({ x: '{a}' }, {})).toEqual({ x: '' });
  });

  it('handles partial substitution within a larger string', () => {
    expect(substitutePlaceholders('prefix-{a}-suffix', { a: '123' })).toBe('prefix-123-suffix');
  });

  it('recurses into nested objects and arrays', () => {
    const r = substitutePlaceholders(
      { a: { b: ['{x}', { c: '{y}' }] } },
      { x: '1', y: '2' },
    );
    expect(r).toEqual({ a: { b: ['1', { c: '2' }] } });
  });

  it('substitutes inside object keys, coercing back to string', () => {
    expect(substitutePlaceholders({ 'id.{key}': 1 }, { key: 'foo' })).toEqual({ 'id.foo': 1 });
  });

  it('passes non-string primitive nodes through unchanged', () => {
    expect(substitutePlaceholders(0, {})).toBe(0);
    expect(substitutePlaceholders(true, {})).toBe(true);
    expect(substitutePlaceholders(null, {})).toBe(null);
  });
});

// ── substitutePlaceholders — type=number ──────────────

describe('substitutePlaceholders — type-aware (number)', () => {
  it('replaces "{x}" with a JSON number when types[x]==="number" (the user-reported bug)', () => {
    const pipeline = { $match: { $expr: { $gt: ['{variable}', 0] } } };
    const r = substitutePlaceholders(pipeline, { variable: '221' }, { variable: 'number' });
    expect(r).toEqual({ $match: { $expr: { $gt: [221, 0] } } });
  });

  it('coerces decimal strings to numbers', () => {
    expect(substitutePlaceholders(['{amount}'], { amount: '5552.14' }, { amount: 'number' }))
      .toEqual([5552.14]);
  });

  it('keeps the string form when the value is not finite when coerced', () => {
    expect(substitutePlaceholders(['{x}'], { x: 'not-a-number' }, { x: 'number' }))
      .toEqual(['not-a-number']);
  });

  it('uses string substitution when the placeholder is part of a larger string', () => {
    expect(substitutePlaceholders('prefix-{x}', { x: '221' }, { x: 'number' }))
      .toBe('prefix-221');
  });

  it('does not coerce when types[x] is not "number"', () => {
    expect(substitutePlaceholders(['{x}'], { x: '221' }, { x: 'string' }))
      .toEqual(['221']);
    expect(substitutePlaceholders(['{x}'], { x: '221' }, { x: 'enum' }))
      .toEqual(['221']);
    expect(substitutePlaceholders(['{x}'], { x: '221' }, { x: 'date' }))
      .toEqual(['221']);
  });

  it('falls back to string substitution when no types map is provided', () => {
    expect(substitutePlaceholders(['{x}'], { x: '221' })).toEqual(['221']);
  });

  it('returns empty string for an empty type=number value (no 0 coercion)', () => {
    expect(substitutePlaceholders(['{x}'], { x: '' }, { x: 'number' })).toEqual(['']);
  });

  it('returns empty string when the type=number key is missing', () => {
    expect(substitutePlaceholders(['{x}'], {}, { x: 'number' })).toEqual(['']);
  });

  it('handles "0" correctly (returns the number 0)', () => {
    expect(substitutePlaceholders(['{x}'], { x: '0' }, { x: 'number' })).toEqual([0]);
  });

  it('coerces a value that is already a number', () => {
    expect(substitutePlaceholders(['{x}'], { x: 42 }, { x: 'number' })).toEqual([42]);
  });
});

// ── substitutePlaceholders — modifiers ────────────────

describe('substitutePlaceholders — split modifier', () => {
  it('returns an array when the whole string is the placeholder', () => {
    const r = substitutePlaceholders(
      { $in: "{order_id_normalized | split(',')}" },
      { order_id_normalized: 'PO-1,PO-2,PO-3' },
    );
    expect(r).toEqual({ $in: ['PO-1', 'PO-2', 'PO-3'] });
  });

  it('splits on a space delimiter', () => {
    const r = substitutePlaceholders(["{words | split(' ')}"], { words: 'a b c' });
    expect(r).toEqual([['a', 'b', 'c']]);
  });

  it('returns a single-element array for an empty value', () => {
    expect(substitutePlaceholders(["{x | split(',')}"], { x: '' })).toEqual([['']]);
  });

  it('returns empty string when the key is missing', () => {
    expect(substitutePlaceholders(["{x | split(',')}"], {})).toEqual(['']);
  });

  it('overrides type=number coercion when a modifier is present', () => {
    const r = substitutePlaceholders(
      ["{x | split(',')}"],
      { x: '1,2,3' },
      { x: 'number' },
    );
    expect(r).toEqual([['1', '2', '3']]);
  });

  it('tolerates whitespace around the placeholder name and pipe', () => {
    expect(substitutePlaceholders(["{ x | split(',') }"], { x: 'a,b' }))
      .toEqual([['a', 'b']]);
  });
});

describe('substitutePlaceholders — re modifier', () => {
  it('escapes regex special characters', () => {
    expect(substitutePlaceholders(['{x | re}'], { x: 'a.b*c+d' }))
      .toEqual(['a\\.b\\*c\\+d']);
  });

  it('escapes the full set of regex specials', () => {
    expect(substitutePlaceholders(['{x | re}'], { x: '.*+?^${}()|[]\\' }))
      .toEqual(['\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\']);
  });

  it('still produces a string for partial substitutions', () => {
    expect(substitutePlaceholders(['^{x | re}$'], { x: 'a.b' }))
      .toEqual(['^a\\.b$']);
  });
});

// ── flattenContent ────────────────────────────────────

// Rossum's content endpoint does NOT return a per-datapoint `type` field.
// type=number is detected via the `normalized_value` heuristic — see
// `isNumberContent` in mdh-provenance.js.

describe('flattenContent', () => {
  it('classifies datapoints with a finite normalized_value as type=number', () => {
    const content = {
      content: [
        { schema_id: 'amount', category: 'datapoint',
          content: { value: '5,552.14', normalized_value: '5552.14' } },
        { schema_id: 'vendor', category: 'datapoint',
          content: { value: 'ACME', normalized_value: null } },
      ],
    };
    const flat = flattenContent(content);
    expect(flat.headerValues).toEqual({ amount: '5552.14', vendor: 'ACME' });
    expect(flat.types).toEqual({ amount: 'number' });
  });

  it('uses normalized_value (canonical) for type=number so Number() coerces correctly', () => {
    const content = {
      content: [
        { schema_id: 'amount', category: 'datapoint',
          content: { value: '5,552.14', normalized_value: '5552.14' } },
      ],
    };
    expect(flattenContent(content).headerValues.amount).toBe('5552.14');
  });

  it('does not classify dates as type=number (ISO normalized_value parses to NaN)', () => {
    const content = {
      content: [
        { schema_id: 'date', category: 'datapoint',
          content: { value: '01/05/2026', normalized_value: '2026-05-01' } },
      ],
    };
    const flat = flattenContent(content);
    expect(flat.headerValues.date).toBe('01/05/2026');
    expect(flat.types).toEqual({});
  });

  it('does not classify string fields with numeric-looking value as type=number when normalized_value is null', () => {
    const content = {
      content: [
        { schema_id: 'document_id', category: 'datapoint',
          content: { value: '315610', normalized_value: null } },
      ],
    };
    const flat = flattenContent(content);
    expect(flat.headerValues.document_id).toBe('315610');
    expect(flat.types).toEqual({});
  });

  it('does not classify empty fields (normalized_value === "") as type=number', () => {
    const content = {
      content: [
        { schema_id: 'amount', category: 'datapoint',
          content: { value: '', normalized_value: '' } },
      ],
    };
    expect(flattenContent(content).types).toEqual({});
  });

  it('extracts row datapoints from multivalue/tuple and detects per-schema types', () => {
    const content = {
      content: [
        {
          schema_id: 'line_items', category: 'multivalue',
          children: [
            {
              category: 'tuple',
              children: [
                { schema_id: 'qty', category: 'datapoint',
                  content: { value: '3', normalized_value: '3' } },
                { schema_id: 'sku', category: 'datapoint',
                  content: { value: 'A1', normalized_value: null } },
              ],
            },
            {
              category: 'tuple',
              children: [
                { schema_id: 'qty', category: 'datapoint',
                  content: { value: '7', normalized_value: '7' } },
                { schema_id: 'sku', category: 'datapoint',
                  content: { value: 'B2', normalized_value: null } },
              ],
            },
          ],
        },
      ],
    };
    const flat = flattenContent(content);
    expect(flat.rowCount).toBe(2);
    expect(flat.rowValues).toEqual({ qty: ['3', '7'], sku: ['A1', 'B2'] });
    expect(flat.types).toEqual({ qty: 'number' });
  });

  it('matches the real-world bug case (item_amount=0.65 inside a multivalue)', () => {
    const content = {
      content: [
        {
          schema_id: 'line_items', category: 'multivalue',
          children: [
            {
              category: 'tuple',
              children: [
                { schema_id: 'item_amount', category: 'datapoint',
                  content: { value: '0.65', normalized_value: '0.65' } },
              ],
            },
          ],
        },
      ],
    };
    const flat = flattenContent(content);
    expect(flat.rowValues.item_amount).toEqual(['0.65']);
    expect(flat.types).toEqual({ item_amount: 'number' });
  });
});
