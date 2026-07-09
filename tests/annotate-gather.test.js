import { describe, it, expect, vi } from 'vitest';
import { flattenFields, gatherAnnotation } from '../src/rossum/annotate/gather.js';

const tree = [
  { category: 'section', children: [
    { category: 'datapoint', id: 11, schema_id: 'document_id',
      content: { value: '123', position: [1, 2, 3, 4], page: 1, rir_confidence: 0.9 } },
    { category: 'multivalue', id: 200, schema_id: 'line_items', children: [
      { category: 'tuple', children: [
        { category: 'datapoint', id: 22, schema_id: 'item_desc',
          content: { value: 'x', position: [5, 6, 7, 8], page: 1, rir_confidence: 0.4 } },
      ] },
    ] },
  ] },
];

describe('flattenFields', () => {
  it('walks sections/multivalue/tuple and returns every datapoint', () => {
    const fields = flattenFields(tree);
    expect(fields).toEqual([
      { datapointId: 11, schemaId: 'document_id', value: '123', position: [1, 2, 3, 4], rirPosition: null, page: 1, confidence: 0.9, rowIndex: null, inLineItem: false, mvSchemaId: null, mvId: null },
      { datapointId: 22, schemaId: 'item_desc', value: 'x', position: [5, 6, 7, 8], rirPosition: null, page: 1, confidence: 0.4, rowIndex: 1, inLineItem: true, mvSchemaId: 'line_items', mvId: 200 },
    ]);
  });
  it('tolerates missing content', () => {
    expect(flattenFields([{ category: 'datapoint', id: 1, schema_id: 's' }])).toEqual([
      { datapointId: 1, schemaId: 's', value: null, position: null, rirPosition: null, page: null, confidence: null, rowIndex: null, inLineItem: false, mvSchemaId: null, mvId: null },
    ]);
  });
  it('carries the owning multivalue schema id + content id on line-item cells', () => {
    const f = flattenFields(tree);
    expect(f.find((x) => x.datapointId === 22)).toMatchObject({ mvSchemaId: 'line_items', mvId: 200 });
    expect(f.find((x) => x.datapointId === 11)).toMatchObject({ mvSchemaId: null, mvId: null });
  });
});

describe('flattenFields line-item context', () => {
  const lineItemTree = [{ category: 'section', children: [
    { category: 'datapoint', id: 1, schema_id: 'total', content: { value: 'x', position: [0, 0, 1, 1], page: 1, rir_confidence: 0.9 } },
    { category: 'multivalue', children: [
      { category: 'tuple', children: [{ category: 'datapoint', id: 10, schema_id: 'item_amount', content: { value: 'a' } }] },
      { category: 'tuple', children: [{ category: 'datapoint', id: 11, schema_id: 'item_amount', content: { value: 'b' } }] },
    ] },
  ] }];
  it('marks header fields inLineItem:false rowIndex:null and tuple cells with 1-based rowIndex', () => {
    const f = flattenFields(lineItemTree);
    expect(f.find((x) => x.datapointId === 1)).toMatchObject({ inLineItem: false, rowIndex: null });
    expect(f.find((x) => x.datapointId === 10)).toMatchObject({ schemaId: 'item_amount', inLineItem: true, rowIndex: 1 });
    expect(f.find((x) => x.datapointId === 11)).toMatchObject({ schemaId: 'item_amount', inLineItem: true, rowIndex: 2 });
  });
});

describe('gatherAnnotation', () => {
  it('fetches content, page_data, pages+images, annotation messages, schema', async () => {
    const getJson = vi.fn((p) => {
      if (p === '/api/v1/annotations/5/content') return Promise.resolve({ content: tree });
      if (p === '/api/v1/annotations/5') return Promise.resolve({
        messages: [{ id: 11, type: 'error', content: 'bad' }],
        schema: 'https://x.rossum.app/api/v1/schemas/7',
      });
      if (p === '/api/v1/annotations/5/page_data?granularity=words') return Promise.resolve({
        results: [{ page_number: 1, items: [{ position: [1, 2, 3, 4], text: 'INV' }] }],
      });
      if (p === '/api/v1/pages?annotation=5') return Promise.resolve({
        results: [{ id: 99, number: 1, width: 1240, height: 1605 }],
      });
      if (p === '/api/v1/schemas/7') return Promise.resolve({
        content: [{ category: 'datapoint', id: 'document_id', label: 'Invoice', type: 'string', constraints: { required: true } }],
      });
      throw new Error('unexpected ' + p);
    });
    const getBase64 = vi.fn(() => Promise.resolve('BASE64'));
    const g = await gatherAnnotation(5, { getJson, getBase64 });
    expect(g.fields).toHaveLength(2);
    expect(g.ocrPages).toEqual([{ page: 1, width: 1240, height: 1605, words: [{ text: 'INV', position: [1, 2, 3, 4] }] }]);
    expect(g.pageImages).toEqual([{ page: 1, mediaType: 'image/png', data: 'BASE64' }]);
    expect(g.messages).toEqual([{ datapointId: 11, type: 'error', content: 'bad' }]);
    expect(g.schemaFields).toEqual([{ schemaId: 'document_id', label: 'Invoice', type: 'string', required: true, options: null }]);
    expect(getBase64).toHaveBeenCalledWith('/api/v1/pages/99/preview');
  });

  it('degrades to schemaFields: [] when the schema fetch fails, keeping other fields intact', async () => {
    const getJson = vi.fn((p) => {
      if (p === '/api/v1/annotations/5/content') return Promise.resolve({ content: tree });
      if (p === '/api/v1/annotations/5') return Promise.resolve({
        messages: [{ id: 11, type: 'error', content: 'bad' }],
        schema: 'https://x.rossum.app/api/v1/schemas/7',
      });
      if (p === '/api/v1/annotations/5/page_data?granularity=words') return Promise.resolve({
        results: [{ page_number: 1, items: [{ position: [1, 2, 3, 4], text: 'INV' }] }],
      });
      if (p === '/api/v1/pages?annotation=5') return Promise.resolve({
        results: [{ id: 99, number: 1, width: 1240, height: 1605 }],
      });
      if (p === '/api/v1/schemas/7') return Promise.reject(new Error('403 forbidden'));
      throw new Error('unexpected ' + p);
    });
    const getBase64 = vi.fn(() => Promise.resolve('BASE64'));
    const g = await gatherAnnotation(5, { getJson, getBase64 });
    expect(g.schemaFields).toEqual([]);
    expect(g.fields).toHaveLength(2);
    expect(g.ocrPages).toEqual([{ page: 1, width: 1240, height: 1605, words: [{ text: 'INV', position: [1, 2, 3, 4] }] }]);
    expect(g.pageImages).toEqual([{ page: 1, mediaType: 'image/png', data: 'BASE64' }]);
    expect(g.messages).toEqual([{ datapointId: 11, type: 'error', content: 'bad' }]);
  });

  it('flattens a nested schema where a multivalue children is a single tuple object (not array)', async () => {
    const nestedSchema = [
      { category: 'section', children: [
        { category: 'multivalue', id: 'line_items', children: { category: 'tuple', children: [
          { category: 'datapoint', id: 'item_desc', label: 'Item', type: 'string', constraints: { required: false } },
        ] } },
      ] },
    ];
    const getJson = vi.fn((p) => {
      if (p === '/api/v1/annotations/5/content') return Promise.resolve({ content: tree });
      if (p === '/api/v1/annotations/5') return Promise.resolve({
        messages: [],
        schema: 'https://x.rossum.app/api/v1/schemas/7',
      });
      if (p === '/api/v1/annotations/5/page_data?granularity=words') return Promise.resolve({ results: [] });
      if (p === '/api/v1/pages?annotation=5') return Promise.resolve({ results: [] });
      if (p === '/api/v1/schemas/7') return Promise.resolve({ content: nestedSchema });
      throw new Error('unexpected ' + p);
    });
    const getBase64 = vi.fn(() => Promise.resolve('BASE64'));
    const g = await gatherAnnotation(5, { getJson, getBase64 });
    expect(g.schemaFields).toEqual([
      { schemaId: 'item_desc', label: 'Item', type: 'string', required: false, options: null },
    ]);
    expect(g.tableColumns).toEqual({ line_items: ['item_desc'] }); // schema-sourced — survives emptied tables
  });

  it('carries enum options through flattenSchema', async () => {
    const getJson = vi.fn((p) => {
      if (p.endsWith('/content')) return Promise.resolve({ content: [] });
      if (/annotations\/5$/.test(p)) return Promise.resolve({ messages: [], schema: 'https://x/api/v1/schemas/7' });
      if (p.includes('page_data')) return Promise.resolve({ results: [] });
      if (p.includes('pages?annotation')) return Promise.resolve({ results: [] });
      if (p.includes('schemas/7')) return Promise.resolve({ content: [{ category: 'section', children: [
        { category: 'datapoint', id: 'document_type', label: 'Type', type: 'enum', options: [{ value: 'tax_invoice', label: 'Tax invoice' }] },
      ] }] });
      throw new Error('x ' + p);
    });
    const g = await gatherAnnotation(5, { getJson, getBase64: vi.fn(() => Promise.resolve('B')) });
    expect(g.schemaFields).toEqual([
      { schemaId: 'document_type', label: 'Type', type: 'enum', required: false, options: [{ value: 'tax_invoice', label: 'Tax invoice' }] },
    ]);
  });
});

import { collectMultivalues, multivalueRowIds } from '../src/rossum/annotate/gather.js';
describe('collectMultivalues / multivalueRowIds', () => {
  const tree = [{ category: 'section', children: [
    { category: 'multivalue', id: 500, schema_id: 'tax_details', children: [
      { category: 'tuple', id: 5001, children: [] },
    ] },
    { category: 'multivalue', id: 600, schema_id: 'line_items', children: [] }, // empty table
  ] }];
  it('collectMultivalues maps every multivalue schema_id → content id (incl. empty)', () => {
    expect(collectMultivalues(tree)).toEqual({ tax_details: 500, line_items: 600 });
  });
  it('multivalueRowIds returns the tuple ids of a given table', () => {
    expect(multivalueRowIds(tree, 'tax_details')).toEqual([5001]);
    expect(multivalueRowIds(tree, 'line_items')).toEqual([]);
  });
});
