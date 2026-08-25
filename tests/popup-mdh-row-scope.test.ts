// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import ConfigBlock from '../src/popup/components/ConfigBlock.jsx';
import { flattenContent } from '../src/popup/mdh-provenance.js';

// Condition-based wait — never fixed timeouts (repo rule).
async function waitFor(cond: any, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Mirrors the reported document: a 4-row tax table beside 23 line items. The
// panel used to offer 23 rows to BOTH configs, because the row count was the
// maximum across every table in the annotation.
const dp = (schemaId: any, value: any) => ({
  schema_id: schemaId,
  category: 'datapoint',
  content: { value, normalized_value: null },
});
const tuple = (columns: any) => ({ category: 'tuple', schema_id: 'row', children: columns });

const CONTENT = {
  content: [
    {
      category: 'multivalue',
      schema_id: 'tax_amounts',
      children: Array.from({ length: 4 }, (_, i) => tuple([
        dp('tax_description', `TAX-${i}`),
        dp('tax_code_matched', ''),
      ])),
    },
    {
      category: 'multivalue',
      schema_id: 'line_items',
      children: Array.from({ length: 23 }, (_, i) => tuple([
        dp('item_description', `ITEM-${i}`),
        dp('item_tax_code_match', ''),
      ])),
    },
  ],
};

const FLAT = flattenContent(CONTENT);
const CTX = { token: 'tok', domain: 'https://org.rossum.app', annotationId: '5' };

const taxCfg = () => ({
  name: 'Tax Codes (line-items)',
  target: 'tax_code_matched',
  dataset: 'tax_codes',
  datasetKey: 'code',
  queries: [{ label: 'exact', raw: { find: { d: '{tax_description}' } }, placeholders: ['tax_description'] }],
  actionCondition: null,
  actionConditionPlaceholders: [],
  additionalMappings: [],
});

const lineCfg = () => ({
  name: 'Order lines',
  target: 'item_tax_code_match',
  dataset: 'po_lines',
  datasetKey: 'line',
  queries: [{ label: 'exact', raw: { find: { d: '{item_description}' } }, placeholders: ['item_description'] }],
  actionCondition: null,
  actionConditionPlaceholders: [],
  additionalMappings: [],
});

function mount(root: any, cfg: any, extra = {}) {
  render(h(ConfigBlock, {
    ctx: CTX,
    cfg,
    cfgKey: 'h1::0',
    headerValues: FLAT.headerValues,
    rowValues: FLAT.rowValues,
    rowCount: FLAT.rowCount,
    tables: FLAT.tables,
    types: FLAT.types,
    annotationModifiedAt: null,
    rowByTable: {},
    onRowChange: () => {},
    forceRefreshNonce: 0,
    onOpenInDm: () => {},
    ...extra,
  }), root);
}

let root: any;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ result: [] }),
    clone() { return this; },
    text: async () => '',
  })));
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('row picker scope', () => {
  it('offers the tax table row count, not the bigger line-items count', async () => {
    mount(root, taxCfg());
    await waitFor(() => !!root.querySelector('.mdh-row-picker'));
    expect(root.querySelector('.mdh-row-of').textContent).toContain('of 4');
    expect(root.querySelectorAll('.mdh-row-select option')).toHaveLength(4);
  });

  it('offers the line-items count for a line-item target', async () => {
    mount(root, lineCfg());
    await waitFor(() => !!root.querySelector('.mdh-row-picker'));
    expect(root.querySelector('.mdh-row-of').textContent).toContain('of 23');
    expect(root.querySelectorAll('.mdh-row-select option')).toHaveLength(23);
  });

  it('names the table the rows belong to, so two configs are distinguishable', async () => {
    mount(root, taxCfg());
    await waitFor(() => !!root.querySelector('.mdh-row-picker'));
    expect(root.querySelector('.mdh-row-picker').textContent).toContain('tax_amounts');
  });

  it('reports the changed row against the table it belongs to', async () => {
    const onRowChange = vi.fn();
    mount(root, taxCfg(), { onRowChange });
    await waitFor(() => !!root.querySelector('.mdh-row-select'));
    const select: any = root.querySelector('.mdh-row-select');
    select.value = '2';
    select.dispatchEvent(new Event('change'));
    expect(onRowChange).toHaveBeenCalledWith('tax_amounts', 2);
  });

  it('reads its selected row from its own table only', async () => {
    // line_items sits on row 9; the tax config must ignore that entirely.
    mount(root, taxCfg(), { rowByTable: { line_items: 9, tax_amounts: 3 } });
    await waitFor(() => !!root.querySelector('.mdh-row-select'));
    expect(root.querySelector('.mdh-row-select').value).toBe('3');
  });

  it('clamps a selection that outlives its table instead of substituting empties', async () => {
    mount(root, taxCfg(), { rowByTable: { tax_amounts: 17 } });
    await waitFor(() => !!root.querySelector('.mdh-row-select'));
    expect(root.querySelector('.mdh-row-select').value).toBe('3');
  });

  it('renders no picker when the tables list is unavailable', async () => {
    mount(root, taxCfg(), { tables: undefined });
    await waitFor(() => !!root.querySelector('.mdh-cfg'));
    expect(root.querySelector('.mdh-row-picker')).toBeNull();
  });
});
