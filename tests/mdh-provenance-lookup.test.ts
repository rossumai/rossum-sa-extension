import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractLookupConfigs,
  flattenContent,
  lookupResultFor,
  lookupStatuses,
  readVariableValues,
  resolveLookupVariables,
  substituteLookupVars,
  withVariableDatapoints,
} from '../src/popup/mdh-provenance.js';

// Shapes mirror the live EPD fixture (docs/superpowers/specs/2026-09-24-mdh-provenance-
// lookup-fields-design.md §2): a header lookup and a line-item lookup with a cascade.
const lookupDp = (id: string, dataset: string, queries: any[], variables: any) => ({
  category: 'datapoint',
  id,
  label: `${id} label`,
  type: 'enum',
  ui_configuration: { type: 'lookup', edit: 'enabled' },
  matching: { type: 'master_data_hub', configuration: { dataset, queries, variables } },
});
const UOM_QUERIES = [
  { '//': 'Exact UoM code', aggregate: [{ $match: { $expr: { $eq: ['$code', '$$uom'] } } }] },
  { '//': 'UoM name prefix', aggregate: [{ $match: { name: '$$uom', keep: 'R$$uom' } }] },
];
const SCHEMA = [
  {
    category: 'section',
    id: 'vendor',
    children: [
      { category: 'datapoint', id: 'sender_name', type: 'string' },
      lookupDp(
        'supplier_match',
        'suppliers',
        [{ aggregate: [{ $search: { text: { query: '$$sender', path: 'name' } } }] }],
        { sender: { __formula: 'field.sender_name' } },
      ),
      {
        category: 'datapoint',
        id: 'hook_driven',
        ui_configuration: { type: 'lookup' },
        matching: { type: 'hook_interface' },
      },
      { category: 'datapoint', id: 'plain', ui_configuration: { type: 'captured' } },
    ],
  },
  {
    category: 'section',
    id: 'items',
    children: [
      {
        category: 'multivalue',
        id: 'line_items',
        children: {
          category: 'tuple',
          id: 'line_item',
          children: [
            { category: 'datapoint', id: 'item_uom', type: 'string' },
            lookupDp('item_uom_match', 'uoms', UOM_QUERIES, {
              uom: { __formula: 'field.item_uom' },
            }),
          ],
        },
      },
    ],
  },
];

describe('extractLookupConfigs', () => {
  const cfgs = extractLookupConfigs(SCHEMA);

  it('finds master_data_hub lookups only, header and tuple alike', () => {
    expect(cfgs.map((c) => c.target)).toEqual(['supplier_match', 'item_uom_match']);
  });

  it('shapes each like a hook cfg, with its table and variables', () => {
    const [supplier, uom] = cfgs;
    expect(supplier).toMatchObject({
      source: 'lookup',
      name: 'supplier_match label',
      dataset: 'suppliers',
      tableSchemaId: null,
      actionCondition: null,
      variables: { sender: { __formula: 'field.sender_name' } },
    });
    expect(uom.tableSchemaId).toBe('line_items');
  });

  it('labels queries by `//` and lists the WHOLE-string $$ names each uses', () => {
    const uom = cfgs[1];
    expect(uom.queries.map((q: any) => q.label)).toEqual(['Exact UoM code', 'UoM name prefix']);
    expect(uom.queries.map((q: any) => q.placeholders)).toEqual([['uom'], ['uom']]);
    expect(cfgs[0].queries[0].placeholders).toEqual(['sender']);
  });
});

// A saved annotation after the engine ran (live shapes: a winner carries options
// with struct.__query_index; a no-match has NO options key).
const opt = (value: string, q: number) => ({ value, label: value, struct: { __query_index: q } });
const row = (uom: string, match: any) => ({
  category: 'tuple',
  schema_id: 'line_item',
  children: [
    { category: 'datapoint', schema_id: 'item_uom', content: { value: uom } },
    { category: 'datapoint', schema_id: 'item_uom_match', ...match },
  ],
});
const CONTENT = {
  content: [
    {
      category: 'section',
      schema_id: 'vendor',
      children: [
        {
          category: 'datapoint',
          schema_id: 'supplier_match',
          content: { value: '920' },
          // The value is the SECOND option: it decides the winner.
          options: [opt('102', 0), opt('920', 2)],
        },
      ],
    },
    {
      category: 'section',
      schema_id: 'items',
      children: [
        {
          category: 'multivalue',
          schema_id: 'line_items',
          children: [
            row('hours', { content: { value: 'HR' }, options: [opt('HR', 1)] }),
            row('EA', { content: { value: 'EA' }, options: [opt('EA', 0)] }),
            row('zzz', { content: { value: '' } }),
            row('x', { content: { value: 'X' }, options: [opt('X', 0)], no_recalculation: true }),
          ],
        },
      ],
    },
  ],
};

describe('flattenContent → lookupResults', () => {
  const flat = flattenContent(CONTENT, ['supplier_match', 'item_uom_match']);

  it('keeps a header result, where the datapoint value picks the winner', () => {
    expect(flat.lookupResults.supplier_match).toEqual({
      value: '920',
      winnerIndex: 2,
      optionCount: 2,
      noRecalculation: false,
    });
  });

  it('keeps one result per row, in table order', () => {
    const rows = flat.lookupResults.item_uom_match as any[];
    expect(rows.map((r) => r.winnerIndex)).toEqual([1, 0, null, 0]);
    expect(rows[2].optionCount).toBe(0);
    expect(rows[3].noRecalculation).toBe(true);
  });

  it('collects nothing it was not asked for', () => {
    expect(flattenContent(CONTENT).lookupResults).toEqual({});
  });
});

describe('lookupStatuses', () => {
  const cfg = { queries: [{}, {}, {}] };
  const res = (winnerIndex: number | null, optionCount = 1) => ({
    value: '',
    winnerIndex,
    optionCount,
    noRecalculation: false,
  });

  it('marks earlier queries empty, the winner, and later ones skipped', () => {
    expect(lookupStatuses(cfg, res(1, 2)).map((s) => s.status)).toEqual([
      'empty',
      'winner',
      'skipped',
    ]);
    expect(lookupStatuses(cfg, res(1, 2))[1].hint).toBe('2 options');
    expect(lookupStatuses(cfg, res(0))[0].hint).toBe('1 option');
  });

  it('marks every query empty when nothing matched or no result exists', () => {
    expect(lookupStatuses(cfg, res(null)).map((s) => s.status)).toEqual([
      'empty',
      'empty',
      'empty',
    ]);
    expect(lookupStatuses(cfg, null).map((s) => s.status)).toEqual(['empty', 'empty', 'empty']);
  });
});

describe('lookupResultFor', () => {
  const results = { h: { winnerIndex: 0 }, r: [{ winnerIndex: 1 }, { winnerIndex: 0 }] } as any;
  it('ignores the row for a header lookup and indexes it for a table lookup', () => {
    expect(lookupResultFor(results, { target: 'h' }, 1)!.winnerIndex).toBe(0);
    expect(lookupResultFor(results, { target: 'r' }, 1)!.winnerIndex).toBe(0);
    expect(lookupResultFor(results, { target: 'r' }, 9)).toBeNull();
    expect(lookupResultFor(results, { target: 'missing' }, 0)).toBeNull();
  });
});

describe('substituteLookupVars', () => {
  it('replaces WHOLE "$$name" strings only, and leaves unknown names alone', () => {
    const out = substituteLookupVars(UOM_QUERIES[1].aggregate, { uom: 'hours' });
    expect(out).toEqual([{ $match: { name: 'hours', keep: 'R$$uom' } }]);
    expect(substituteLookupVars('$$other', { uom: 'x' })).toBe('$$other');
    expect(substituteLookupVars('$$ROOT', { ROOT: 'x' })).toBe('$$ROOT');
  });
});

describe('withVariableDatapoints', () => {
  const uom = extractLookupConfigs(SCHEMA)[1];

  it('adds a __var__ formula datapoint beside the target, inside its tuple', () => {
    const out = withVariableDatapoints(SCHEMA, uom);
    const tupleIds = out[1].children[0].children.children.map((c: any) => c.id);
    expect(tupleIds).toEqual(['item_uom', 'item_uom_match', '__var__uom']);
    const added = out[1].children[0].children.children[2];
    expect(added).toMatchObject({
      formula: 'field.item_uom',
      ui_configuration: { type: 'formula' },
    });
  });

  it('does not mutate the schema it was given', () => {
    withVariableDatapoints(SCHEMA, uom);
    expect(JSON.stringify(SCHEMA)).not.toContain('__var__');
  });
});

describe('readVariableValues', () => {
  const evaluated = [
    {
      category: 'section',
      children: [{ schema_id: '__var__sender', content: { value: 'Acme' } }],
    },
    {
      category: 'section',
      children: [
        {
          category: 'multivalue',
          schema_id: 'line_items',
          children: [
            {
              category: 'tuple',
              children: [{ schema_id: '__var__uom', content: { value: 'hours' } }],
            },
            {
              category: 'tuple',
              children: [{ schema_id: '__var__uom', content: { value: 'EA' } }],
            },
          ],
        },
      ],
    },
  ];

  it('reads a header variable, and a row variable from the selected row', () => {
    expect(readVariableValues(evaluated, { tableSchemaId: null }, 0)).toEqual({ sender: 'Acme' });
    expect(readVariableValues(evaluated, { tableSchemaId: 'line_items' }, 1)).toEqual({
      uom: 'EA',
    });
  });

  it('never reads a row variable into a header lookup', () => {
    expect(readVariableValues(evaluated, { tableSchemaId: null }, 0)).not.toHaveProperty('uom');
  });
});

describe('resolveLookupVariables', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the schema with __var__ datapoints and the annotation content', async () => {
    const posted: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: any) => {
        const body = (() => {
          if (url.includes('/queues/')) return { schema: 'https://org/api/v1/schemas/1' };
          if (url.includes('/schemas/1')) return { content: SCHEMA };
          if (url.includes('/content')) return { content: CONTENT.content };
          posted.push(JSON.parse(init.body));
          return {
            annotation_content: [
              {
                category: 'section',
                children: [{ schema_id: '__var__sender', content: { value: 'Acme' } }],
              },
            ],
          };
        })();
        return { ok: true, json: async () => body };
      }),
    );
    const cfg = extractLookupConfigs(SCHEMA)[0];
    const values = await resolveLookupVariables('https://org', 'tok', 42, 5, cfg, 0);
    expect(values).toEqual({ sender: 'Acme' });
    expect(JSON.stringify(posted[0].schema_content)).toContain('__var__sender');
    expect(posted[0].annotation_content).toEqual(CONTENT.content);
  });

  it('rejects when evaluate_formulas is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('evaluate_formulas')
          ? { ok: false, status: 403 }
          : {
              ok: true,
              json: async () =>
                url.includes('/queues/') ? { schema: 'https://org/s' } : { content: [] },
            },
      ),
    );
    await expect(
      resolveLookupVariables('https://org', 'tok', 42, 5, extractLookupConfigs(SCHEMA)[0], 0),
    ).rejects.toThrow('403');
  });
});
