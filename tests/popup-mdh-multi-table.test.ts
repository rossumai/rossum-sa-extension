// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import MdhProvenancePanel from '../src/popup/components/MdhProvenancePanel.jsx';

// Condition-based wait — never fixed timeouts (repo rule).
async function waitFor(cond: any, timeout = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const DOMAIN = 'https://org.rossum.app';
const TAB = { id: 1, windowId: 7, index: 0, url: `${DOMAIN}/document/5` };

const dp = (schemaId: any, value: any) => ({
  schema_id: schemaId,
  category: 'datapoint',
  content: { value, normalized_value: null },
});
const tuple = (columns: any) => ({ category: 'tuple', schema_id: 'row', children: columns });

// One annotation, two tables of different sizes — the reported shape.
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

// One hook carrying both configs: one writes into the tax table, one into the
// line-items table.
const HOOKS = {
  results: [{
    id: 900,
    name: 'MDH matching',
    active: true,
    type: 'webhook',
    settings: {
      configurations: [
        {
          name: 'Tax codes',
          mapping: { target_schema_id: 'tax_code_matched' },
          source: {
            dataset: 'tax_codes',
            queries: [{ name: 'exact', find: { d: '{tax_description}' } }],
          },
        },
        {
          name: 'Order lines',
          mapping: { target_schema_id: 'item_tax_code_match' },
          source: {
            dataset: 'po_lines',
            queries: [{ name: 'exact', find: { d: '{item_description}' } }],
          },
        },
      ],
    },
  }],
};

let root: any;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.stubGlobal('chrome', {
    scripting: {
      executeScript: vi.fn(async () => [{
        result: { token: 'tok', domain: DOMAIN, annotationId: '5', queueId: '42' },
      }]),
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    runtime: { sendMessage: vi.fn() },
  });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const body = (() => {
      if (url.includes('/api/v1/hooks?')) return HOOKS;
      if (url.includes('/content')) return CONTENT;
      if (url.includes('/data/aggregate')) return { result: [] };
      if (url.includes('/api/v1/queues/')) return {}; // no schema -> types {}
      return {};
    })();
    return { ok: true, json: async () => body, clone() { return this; }, text: async () => '' };
  }));
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('MDH provenance with several tables in one document', () => {
  it('gives each config the row count of its own target table', async () => {
    render(h(MdhProvenancePanel, { tab: TAB }), root);
    await waitFor(() => root.querySelectorAll('.mdh-row-picker').length === 2);
    const counts: any = [...root.querySelectorAll('.mdh-row-of')].map((n) => n.textContent.trim());
    expect(counts).toEqual(['of 4', 'of 23']);
  });

  it('keeps the two tables selections independent', async () => {
    render(h(MdhProvenancePanel, { tab: TAB }), root);
    await waitFor(() => root.querySelectorAll('.mdh-row-select').length === 2);
    const [taxSelect, lineSelect] = root.querySelectorAll('.mdh-row-select');

    lineSelect.value = '11';
    lineSelect.dispatchEvent(new Event('change'));
    await waitFor(() => root.querySelectorAll('.mdh-row-select')[1].value === '11');

    // Moving to line-item row 12 must NOT drag the 4-row tax config with it.
    expect(root.querySelectorAll('.mdh-row-select')[0].value).toBe('0');
    expect(taxSelect.querySelectorAll('option')).toHaveLength(4);
  });
});
