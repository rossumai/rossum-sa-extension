import { describe, it, expect } from 'vitest';
import {
  buildSchemaTypes,
  buildVariableTypes,
  collectPlaceholders,
  describeQuery,
  evaluateCfgCondition,
  extractConfigsFromHook,
  filterHookEntries,
  flattenContent,
  hookConfigs,
  loadMdhHooksForQueue,
  loadSchemaTypesForQueue,
  mergeSchemaTypes,
  replayConfig,
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
    expect(describeQuery({ find: { vendor_id: '{x}', country: 'US' } })).toBe(
      'find: vendor_id, country',
    );
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
    const set = new Set<string>();
    collectPlaceholders({ x: '{a}', y: ['{b}', '{c}'], z: { w: '{a}' } }, set);
    expect([...set].sort()).toEqual(['a', 'b', 'c']);
  });

  it('collects the schema_id name from placeholders that carry modifiers', () => {
    const set = new Set<string>();
    collectPlaceholders({ a: "{order_id | split(',')}", b: '{name | re}', c: '{ amount }' }, set);
    expect([...set].sort()).toEqual(['amount', 'name', 'order_id']);
  });

  it('ignores secrets.* placeholders (out of popup scope)', () => {
    const set = new Set<string>();
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
    const r = substitutePlaceholders({ a: { b: ['{x}', { c: '{y}' }] } }, { x: '1', y: '2' });
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
    expect(
      substitutePlaceholders(['{amount}'], { amount: '5552.14' }, { amount: 'number' }),
    ).toEqual([5552.14]);
  });

  it('keeps the string form when the value is not finite when coerced', () => {
    expect(substitutePlaceholders(['{x}'], { x: 'not-a-number' }, { x: 'number' })).toEqual([
      'not-a-number',
    ]);
  });

  it('uses string substitution when the placeholder is part of a larger string', () => {
    expect(substitutePlaceholders('prefix-{x}', { x: '221' }, { x: 'number' })).toBe('prefix-221');
  });

  it('does not coerce when types[x] is not "number"', () => {
    expect(substitutePlaceholders(['{x}'], { x: '221' }, { x: 'string' })).toEqual(['221']);
    expect(substitutePlaceholders(['{x}'], { x: '221' }, { x: 'enum' })).toEqual(['221']);
    expect(substitutePlaceholders(['{x}'], { x: '221' }, { x: 'date' })).toEqual(['221']);
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
    const r = substitutePlaceholders(["{x | split(',')}"], { x: '1,2,3' }, { x: 'number' });
    expect(r).toEqual([['1', '2', '3']]);
  });

  it('tolerates whitespace around the placeholder name and pipe', () => {
    expect(substitutePlaceholders(["{ x | split(',') }"], { x: 'a,b' })).toEqual([['a', 'b']]);
  });
});

describe('substitutePlaceholders — re modifier', () => {
  it('escapes regex special characters', () => {
    expect(substitutePlaceholders(['{x | re}'], { x: 'a.b*c+d' })).toEqual(['a\\.b\\*c\\+d']);
  });

  // The service's `re` value filter is Python re.escape (verified live against
  // /svc/master-data-hub/api/v1/match 2026-07-04): it also escapes `-&~#`,
  // space, and whitespace/control chars — not just the JS regex specials.
  it('escapes the full Python re.escape set of regex specials', () => {
    expect(substitutePlaceholders(['{x | re}'], { x: '.*+?^${}()|[]\\-&~# \t\n\r\v\f' })).toEqual([
      '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\\\-\\&\\~\\#\\ \\\t\\\n\\\r\\\v\\\f',
    ]);
  });

  it('escapes space (verified: "ACME (US)" → "ACME\\ \\(US\\)")', () => {
    expect(substitutePlaceholders(['{x | re}'], { x: 'ACME (US)' })).toEqual(['ACME\\ \\(US\\)']);
  });

  it('leaves non-special printable ASCII untouched (verified live)', () => {
    const kept = '0123456789azAZ!"%\',/:;<=>@_`';
    expect(substitutePlaceholders(['{x | re}'], { x: kept })).toEqual([kept]);
  });

  it('still produces a string for partial substitutions', () => {
    expect(substitutePlaceholders(['^{x | re}$'], { x: 'a.b' })).toEqual(['^a\\.b$']);
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
        {
          schema_id: 'amount',
          category: 'datapoint',
          content: { value: '5,552.14', normalized_value: '5552.14' },
        },
        {
          schema_id: 'vendor',
          category: 'datapoint',
          content: { value: 'ACME', normalized_value: null },
        },
      ],
    };
    const flat = flattenContent(content);
    expect(flat.headerValues).toEqual({ amount: '5552.14', vendor: 'ACME' });
    expect(flat.types).toEqual({ amount: 'number' });
  });

  it('uses normalized_value (canonical) for type=number so Number() coerces correctly', () => {
    const content = {
      content: [
        {
          schema_id: 'amount',
          category: 'datapoint',
          content: { value: '5,552.14', normalized_value: '5552.14' },
        },
      ],
    };
    expect(flattenContent(content).headerValues.amount).toBe('5552.14');
  });

  it('does not classify dates as type=number (ISO normalized_value parses to NaN)', () => {
    const content = {
      content: [
        {
          schema_id: 'date',
          category: 'datapoint',
          content: { value: '01/05/2026', normalized_value: '2026-05-01' },
        },
      ],
    };
    const flat = flattenContent(content);
    expect(flat.headerValues.date).toBe('01/05/2026');
    expect(flat.types).toEqual({});
  });

  it('does not classify string fields with numeric-looking value as type=number when normalized_value is null', () => {
    const content = {
      content: [
        {
          schema_id: 'document_id',
          category: 'datapoint',
          content: { value: '315610', normalized_value: null },
        },
      ],
    };
    const flat = flattenContent(content);
    expect(flat.headerValues.document_id).toBe('315610');
    expect(flat.types).toEqual({});
  });

  it('does not classify empty fields (normalized_value === "") as type=number', () => {
    const content = {
      content: [
        {
          schema_id: 'amount',
          category: 'datapoint',
          content: { value: '', normalized_value: '' },
        },
      ],
    };
    expect(flattenContent(content).types).toEqual({});
  });

  it('extracts row datapoints from multivalue/tuple and detects per-schema types', () => {
    const content = {
      content: [
        {
          schema_id: 'line_items',
          category: 'multivalue',
          children: [
            {
              category: 'tuple',
              children: [
                {
                  schema_id: 'qty',
                  category: 'datapoint',
                  content: { value: '3', normalized_value: '3' },
                },
                {
                  schema_id: 'sku',
                  category: 'datapoint',
                  content: { value: 'A1', normalized_value: null },
                },
              ],
            },
            {
              category: 'tuple',
              children: [
                {
                  schema_id: 'qty',
                  category: 'datapoint',
                  content: { value: '7', normalized_value: '7' },
                },
                {
                  schema_id: 'sku',
                  category: 'datapoint',
                  content: { value: 'B2', normalized_value: null },
                },
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
          schema_id: 'line_items',
          category: 'multivalue',
          children: [
            {
              category: 'tuple',
              children: [
                {
                  schema_id: 'item_amount',
                  category: 'datapoint',
                  content: { value: '0.65', normalized_value: '0.65' },
                },
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

// ── filterHookEntries ─────────────────────────────────

describe('filterHookEntries', () => {
  const sample = () => [
    {
      hook: { id: 1, name: 'A' },
      cfgs: [
        { target: 'vendor_name', dataset: 'd', queries: [] },
        { target: 'vendor_id', dataset: 'd', queries: [] },
      ],
    },
    {
      hook: { id: 2, name: 'B' },
      cfgs: [{ target: 'tax_id', dataset: 'd', queries: [] }],
    },
  ];

  it('returns the original entries when the query is empty or whitespace', () => {
    const entries = sample();
    expect(filterHookEntries(entries, '')).toBe(entries);
    expect(filterHookEntries(entries, '   ')).toBe(entries);
  });

  it('treats null / undefined query as empty', () => {
    const entries = sample();
    expect(filterHookEntries(entries, null)).toBe(entries);
    expect(filterHookEntries(entries, undefined)).toBe(entries);
  });

  it('filters cfgs by case-insensitive substring against target', () => {
    const r = filterHookEntries(sample(), 'VENDOR');
    expect(r).toHaveLength(1);
    expect(r[0].hook.id).toBe(1);
    expect(r[0].cfgs.map((c: any) => c.target)).toEqual(['vendor_name', 'vendor_id']);
  });

  it('matches anywhere inside the target id', () => {
    const r = filterHookEntries(sample(), '_id');
    expect(r).toHaveLength(2);
    expect(r[0].cfgs.map((c: any) => c.target)).toEqual(['vendor_id']);
    expect(r[1].cfgs.map((c: any) => c.target)).toEqual(['tax_id']);
  });

  it('drops hooks whose cfgs all filtered out', () => {
    const r = filterHookEntries(sample(), 'tax');
    expect(r).toHaveLength(1);
    expect(r[0].hook.id).toBe(2);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterHookEntries(sample(), 'zzz')).toEqual([]);
  });

  it('does not mutate the input entries', () => {
    const entries = sample();
    const before = JSON.stringify(entries);
    filterHookEntries(entries, 'vendor');
    expect(JSON.stringify(entries)).toBe(before);
  });

  it('handles cfgs with missing target gracefully (treated as no-match)', () => {
    const e = [{ hook: { id: 1 }, cfgs: [{ dataset: 'd', queries: [] }] }];
    expect(filterHookEntries(e, 'foo')).toEqual([]);
  });

  it('matches against additionalMappings targets too', () => {
    const e = [
      {
        hook: { id: 1, name: 'A' },
        cfgs: [
          {
            target: 'vendor_match',
            dataset: 'd',
            queries: [],
            additionalMappings: [
              { target: 'vendor_name', datasetKey: 'name' },
              { target: 'vendor_address', datasetKey: 'address' },
            ],
          },
        ],
      },
    ];
    // Primary target doesn't contain 'address' but an additional mapping does.
    const r = filterHookEntries(e, 'address');
    expect(r).toHaveLength(1);
    expect(r[0].cfgs[0].target).toBe('vendor_match');
  });
});

// ── extractConfigsFromHook ────────────────────────────

describe('extractConfigsFromHook', () => {
  it('captures action_condition as a non-empty string, or null', () => {
    const hook = {
      settings: {
        configurations: [
          {
            mapping: { target_schema_id: 't1', dataset_key: 'k' },
            source: { dataset: 'd', queries: [] },
            action_condition: "'{x}' != 'True'",
          },
          {
            mapping: { target_schema_id: 't2', dataset_key: 'k' },
            source: { dataset: 'd', queries: [] },
            action_condition: '   ',
          },
          {
            mapping: { target_schema_id: 't3', dataset_key: 'k' },
            source: { dataset: 'd', queries: [] },
          },
        ],
      },
    };
    const cfgs = extractConfigsFromHook(hook);
    expect(cfgs).toHaveLength(3);
    expect(cfgs[0].actionCondition).toBe("'{x}' != 'True'");
    expect(cfgs[0].actionConditionPlaceholders).toEqual(['x']);
    expect(cfgs[1].actionCondition).toBe(null);
    expect(cfgs[1].actionConditionPlaceholders).toEqual([]);
    expect(cfgs[2].actionCondition).toBe(null);
  });

  it('captures additional_mappings as a list of {target, datasetKey}', () => {
    const hook = {
      settings: {
        configurations: [
          {
            mapping: { target_schema_id: 'primary', dataset_key: 'k' },
            source: { dataset: 'd', queries: [] },
            additional_mappings: [
              { target_schema_id: 'name', dataset_key: 'Name' },
              { target_schema_id: 'addr', dataset_key: 'Address' },
              { target_schema_id: '', dataset_key: '' }, // empty entry — dropped
            ],
          },
        ],
      },
    };
    const cfgs = extractConfigsFromHook(hook);
    expect(cfgs[0].additionalMappings).toEqual([
      { target: 'name', datasetKey: 'Name' },
      { target: 'addr', datasetKey: 'Address' },
    ]);
  });

  it('defaults additionalMappings to [] when the field is absent or not an array', () => {
    const hook = {
      settings: {
        configurations: [
          { mapping: { target_schema_id: 't' }, source: { dataset: 'd', queries: [] } },
          {
            mapping: { target_schema_id: 't' },
            source: { dataset: 'd', queries: [] },
            additional_mappings: 'not-an-array',
          },
        ],
      },
    };
    const cfgs = extractConfigsFromHook(hook);
    expect(cfgs[0].additionalMappings).toEqual([]);
    expect(cfgs[1].additionalMappings).toEqual([]);
  });

  it('reads configs from the legacy settings.configs key, not only settings.configurations', () => {
    const hook = {
      settings: {
        configs: [
          {
            name: 'Supplier by VAT number',
            mapping: { target_schema_id: 'supplier_wd', dataset_key: 'Supplier_ID' },
            source: {
              dataset: 'workday_suppliers',
              queries: [{ aggregate: [{ $match: { tax: '{sender_vat_id_normalized}' } }] }],
            },
          },
        ],
      },
    };
    const cfgs = extractConfigsFromHook(hook);
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0].target).toBe('supplier_wd');
    expect(cfgs[0].dataset).toBe('workday_suppliers');
    expect(cfgs[0].queries[0].placeholders).toEqual(['sender_vat_id_normalized']);
  });
});

// ── hookConfigs (configs vs configurations key) ───────

describe('hookConfigs', () => {
  it('prefers the modern settings.configurations when both keys are present', () => {
    const hook = {
      settings: { configs: [{ name: 'legacy' }], configurations: [{ name: 'modern' }] },
    };
    expect(hookConfigs(hook)).toEqual([{ name: 'modern' }]);
  });

  it('falls back to the legacy settings.configs when configurations is absent', () => {
    const hook = { settings: { configs: [{ name: 'legacy' }] } };
    expect(hookConfigs(hook)).toEqual([{ name: 'legacy' }]);
  });

  it('returns [] when neither key holds an array', () => {
    expect(hookConfigs({ settings: {} })).toEqual([]);
    expect(hookConfigs({ settings: { configs: 'nope' } })).toEqual([]);
    expect(hookConfigs({})).toEqual([]);
    expect(hookConfigs(null)).toEqual([]);
  });
});

// ── loadMdhHooksForQueue (the legacy-`configs` false-negative bug) ─

describe('loadMdhHooksForQueue', () => {
  const withFetch = async (results: any, run: any) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ results }) })) as any;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  const dmv2Hook = {
    id: 435212,
    name: 'Data Matching v2 - TEST',
    type: 'webhook',
    active: true,
    settings: {
      // Shape taken from a live hook that used the legacy `configs` key, which the
      // panel previously missed (it only read the modern `configurations`).
      configs: [
        {
          name: 'Supplier by VAT number',
          mapping: { target_schema_id: 'supplier_wd', dataset_key: 'Supplier_ID' },
          source: {
            dataset: 'workday_suppliers',
            queries: [{ aggregate: [{ $match: { tax: '{sender_vat_id_normalized}' } }] }],
          },
        },
      ],
    },
  };

  it('recognizes a webhook MDH hook whose cascade lives under settings.configs', async () => {
    const hooks = await withFetch([dmv2Hook], () =>
      loadMdhHooksForQueue('https://acme.rossum.app', 'token', 1030099),
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0].id).toBe(435212);
  });

  it('still recognizes the modern settings.configurations shape', async () => {
    const legacy = {
      id: 99,
      type: 'webhook',
      active: true,
      settings: { configurations: [{ source: { dataset: 'd', queries: [{ find: {} }] } }] },
    };
    const hooks = await withFetch([legacy], () =>
      loadMdhHooksForQueue('https://x.rossum.app', 'token', 1),
    );
    expect(hooks.map((h: any) => h.id)).toEqual([99]);
  });

  it('excludes inactive hooks and non-webhook types even with a valid config shape', async () => {
    const inactive = { ...dmv2Hook, id: 1, active: false };
    const fn = { ...dmv2Hook, id: 2, type: 'function' };
    const hooks = await withFetch([inactive, fn, dmv2Hook], () =>
      loadMdhHooksForQueue('https://x.rossum.app', 'token', 1),
    );
    expect(hooks.map((h: any) => h.id)).toEqual([435212]);
  });
});

// ── Schema types (authoritative placeholder types) ────

describe('buildSchemaTypes', () => {
  it('maps number and number-enum to number, everything else to string', () => {
    const content = [
      {
        category: 'section',
        children: [
          { category: 'datapoint', id: 'amount', type: 'number' },
          { category: 'datapoint', id: 'cust', type: 'enum', enum_value_type: 'string' },
          { category: 'datapoint', id: 'code', type: 'enum', enum_value_type: 'number' },
          { category: 'datapoint', id: 'name', type: 'string' },
          { category: 'datapoint', id: 'when', type: 'date' },
          {
            category: 'multivalue',
            id: 'items',
            children: {
              category: 'tuple',
              children: [
                { category: 'datapoint', id: 'item_qty', type: 'number' },
                { category: 'datapoint', id: 'item_desc', type: 'string' },
              ],
            },
          },
        ],
      },
    ];
    expect(buildSchemaTypes(content)).toEqual({
      amount: 'number',
      cust: 'string',
      code: 'number',
      name: 'string',
      when: 'string',
      item_qty: 'number',
      item_desc: 'string',
    });
  });
  it('tolerates non-array input', () => {
    expect(buildSchemaTypes(null)).toEqual({});
  });
});

describe('mergeSchemaTypes', () => {
  it('schema wins; heuristic fills fields the schema does not cover', () => {
    expect(mergeSchemaTypes({ a: 'number', b: 'number' }, { b: 'string', c: 'number' })).toEqual({
      a: 'number',
      b: 'string',
      c: 'number',
    });
  });
});

describe('buildVariableTypes', () => {
  it('emits explicit number/string per placeholder from the merged types map', () => {
    expect(buildVariableTypes(['cust', 'amount', 'unknown'], { amount: 'number' })).toEqual({
      cust: 'string',
      amount: 'number',
      unknown: 'string',
    });
  });
});

// ── loadSchemaTypesForQueue ────────────────────────────

describe('loadSchemaTypesForQueue', () => {
  // Two sequential fetches: queue (→ schema url), then schema (→ content).
  const withSequentialFetch = async (responses: any, run: any) => {
    const original = globalThis.fetch;
    let i = 0;
    globalThis.fetch = (async () => {
      const r = responses[i++];
      return { ok: true, json: async () => r };
    }) as any;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it('fetches the queue schema url then the schema content and classifies types', async () => {
    const content = [
      {
        category: 'section',
        children: [
          { category: 'datapoint', id: 'amount', type: 'number' },
          { category: 'datapoint', id: 'name', type: 'string' },
        ],
      },
    ];
    const types = await withSequentialFetch(
      [{ schema: 'https://x.rossum.app/api/v1/schemas/77' }, { content }],
      () => loadSchemaTypesForQueue('https://x.rossum.app', 'token', 123),
    );
    expect(types).toEqual({ amount: 'number', name: 'string' });
  });

  it('returns {} when the queue fetch fails (e.g. 403)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 403 })) as any;
    try {
      const types = await loadSchemaTypesForQueue('https://x.rossum.app', 'token', 123);
      expect(types).toEqual({});
    } finally {
      globalThis.fetch = original;
    }
  });

  it('returns {} when the queue has no schema url', async () => {
    const types = await withSequentialFetch([{}], () =>
      loadSchemaTypesForQueue('https://x.rossum.app', 'token', 123),
    );
    expect(types).toEqual({});
  });
});

// ── evaluateCfgCondition ──────────────────────────────

describe('evaluateCfgCondition', () => {
  it('returns hasCondition=false when the cfg has no action_condition', () => {
    const r = evaluateCfgCondition({ actionCondition: null }, {}, {});
    expect(r.hasCondition).toBe(false);
    expect(r.result).toBe(true);
  });

  it('substitutes placeholders and evaluates the real-world example to true', () => {
    const cfg = { actionCondition: "'{supplier_invoice_any_wd}' != 'True'" };
    const r = evaluateCfgCondition(cfg, { supplier_invoice_any_wd: 'something_else' }, {});
    expect(r.hasCondition).toBe(true);
    expect(r.result).toBe(true);
    expect(r.substituted).toBe("'something_else' != 'True'");
  });

  it('substitutes placeholders and evaluates the real-world example to false', () => {
    const cfg = { actionCondition: "'{supplier_invoice_any_wd}' != 'True'" };
    const r = evaluateCfgCondition(cfg, { supplier_invoice_any_wd: 'True' }, {});
    expect(r.result).toBe(false);
  });

  it('returns result=true when the placeholder is missing (empty-string substitution)', () => {
    const cfg = { actionCondition: "'{missing}' != 'True'" };
    expect(evaluateCfgCondition(cfg, {}, {}).result).toBe(true);
  });

  it('returns result=null with an error when the expression is malformed', () => {
    const cfg = { actionCondition: 'foo == bar' };
    const r = evaluateCfgCondition(cfg, {}, {});
    expect(r.result).toBe(null);
    expect(r.error).toMatch(/unknown identifier/);
  });
});

// ── replayConfig gating ──────────────────────────────

describe('replayConfig (gating on action_condition)', () => {
  it('marks every query as `gated` when action_condition evaluates false, without calling MDH', async () => {
    // No fetch mock — if replayConfig tried to call MDH, this would throw.
    const cfg = {
      dataset: 'd',
      actionCondition: "'{x}' != 'True'",
      queries: [
        { label: 'q1', raw: { aggregate: [{ $match: {} }] }, placeholders: [] },
        { label: 'q2', raw: { aggregate: [{ $match: {} }] }, placeholders: [] },
      ],
    };
    const result = await replayConfig(
      'https://example.com',
      'token',
      cfg,
      { x: 'True' },
      undefined,
      undefined,
      {},
    );
    expect(result).toEqual([
      { status: 'gated', hint: 'action_condition is false' },
      { status: 'gated', hint: 'action_condition is false' },
    ]);
  });

  it('proceeds to replay queries when action_condition is true (broken-fetch path verifies the gate was passed)', async () => {
    const cfg = {
      dataset: 'd',
      actionCondition: 'True',
      queries: [{ label: 'q1', raw: { aggregate: [{ $match: {} }] }, placeholders: [] }],
    };
    // Stub fetch so replay's HTTP call fails — replay should record an `error`
    // status, proving it got past the gate.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('boom');
    };
    try {
      const result = await replayConfig(
        'https://example.com',
        'token',
        cfg,
        {},
        undefined,
        undefined,
        {},
      );
      expect(result).toHaveLength(1);
      expect(result![0].status).toBe('error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
